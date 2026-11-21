import { App, TAbstractFile, TFile, TFolder, normalizePath } from "obsidian";
import { CalendarTab, DateKey } from "../types";
import {
  buildNotePath,
  normalizeFolderPath,
  parseNotePathToDateKey,
} from "../calendar/dateUtils";

// [ID 4.2] 볼트 날짜별 마크다운 파일 스토리지 & 실시간 양방향 동기화 매니저
// -> 커스텀 날짜 포맷(하위 폴더 포함)으로 파일을 조회/생성/수정/삭제하며,
//    빈 파일 생성 방지 및 내용 전체 삭제 시 .md 파일 자동 삭제 규칙을 일관되게 보장함.

export type VaultSyncListener = (tabId: string, dateKey: DateKey) => void;

export class VaultSyncManager {
  private app: App;
  /** 메모리 캐시: cache.get(tabId)?.get(dateKey) = 마크다운 원문 */
  private contentCache = new Map<string, Map<DateKey, string>>();
  private listeners = new Set<VaultSyncListener>();
  private getTabs: () => CalendarTab[];

  constructor(app: App, getTabs: () => CalendarTab[]) {
    this.app = app;
    this.getTabs = getTabs;
  }

  onChange(listener: VaultSyncListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(tabId: string, dateKey: DateKey): void {
    for (const listener of this.listeners) {
      listener(tabId, dateKey);
    }
  }

  getNotePath(tab: CalendarTab, dateKey: DateKey): string {
    return normalizePath(buildNotePath(tab.folderPath, tab.dateFormat, dateKey));
  }

  getNoteFile(tab: CalendarTab, dateKey: DateKey): TFile | null {
    const path = this.getNotePath(tab, dateKey);
    const abstract = this.app.vault.getAbstractFileByPath(path);
    return abstract instanceof TFile ? abstract : null;
  }

  /**
   * 탭의 캐시에서 즉시 내용을 반환 (미로드 시 undefined).
   */
  getCachedContent(tabId: string, dateKey: DateKey): string | undefined {
    return this.contentCache.get(tabId)?.get(dateKey);
  }

  invalidateTabCache(tabId: string): void {
    this.contentCache.delete(tabId);
  }

  /**
   * 날짜 노트의 내용을 읽어 캐시에 반영함. 파일이 없으면 빈 문자열 반환.
   */
  async readMemo(tab: CalendarTab, dateKey: DateKey): Promise<string> {
    let tabMap = this.contentCache.get(tab.id);
    if (!tabMap) {
      tabMap = new Map();
      this.contentCache.set(tab.id, tabMap);
    }

    const file = this.getNoteFile(tab, dateKey);
    if (!file) {
      tabMap.set(dateKey, "");
      return "";
    }

    const content = await this.app.vault.cachedRead(file);
    tabMap.set(dateKey, content);
    return content;
  }

  /**
   * 특정 날짜에 메모 저장.
   * [ID 4.3] 빈 파일 생성 방지 및 전체 삭제 시 자동 파일 삭제
   * -> 공백만 남거나 빈 문자열이면 새 파일을 만들지 않으며, 기존 파일이 존재하면 즉시 삭제함.
   */
  async writeMemo(
    tab: CalendarTab,
    dateKey: DateKey,
    content: string
  ): Promise<void> {
    let tabMap = this.contentCache.get(tab.id);
    if (!tabMap) {
      tabMap = new Map();
      this.contentCache.set(tab.id, tabMap);
    }

    const isBlank = content.trim().length === 0;
    const existing = this.getNoteFile(tab, dateKey);

    if (isBlank) {
      tabMap.set(dateKey, "");
      if (existing) {
        await this.app.fileManager.trashFile(existing);
      }
      this.emit(tab.id, dateKey);
      return;
    }

    if (existing) {
      const current = await this.app.vault.read(existing);
      if (current !== content) {
        await this.app.vault.modify(existing, content);
      }
      tabMap.set(dateKey, content);
      this.emit(tab.id, dateKey);
      return;
    }

    // [ID 4.4] 하위 폴더 자동 생성 (커스텀 날짜 포맷 YYYY/MM/YYYY-MM-DD 대응)
    // -> 파일 경로에 포함된 중첩 폴더가 아직 없으면 순차적으로 생성한 뒤 파일을 만듦.
    const targetPath = this.getNotePath(tab, dateKey);
    await this.ensureParentFolders(targetPath);
    await this.app.vault.create(targetPath, content);
    tabMap.set(dateKey, content);
    this.emit(tab.id, dateKey);
  }

  /**
   * 팝오버에서 MarkdownView 폴백 사용 시 파일이 필요할 때 확보함.
   */
  async ensureFileExists(tab: CalendarTab, dateKey: DateKey): Promise<TFile> {
    const existing = this.getNoteFile(tab, dateKey);
    if (existing) return existing;
    const targetPath = this.getNotePath(tab, dateKey);
    await this.ensureParentFolders(targetPath);
    return await this.app.vault.create(targetPath, "");
  }

  /**
   * 팝오버 열기 시 생성된 임시 빈 파일이 닫힐 때 여전히 비어 있으면 휴지통을 오염시키지 않고 직접 제거함.
   */
  async deleteIfEmptySilently(
    tab: CalendarTab,
    dateKey: DateKey,
    wasCreatedNow: boolean
  ): Promise<void> {
    const file = this.getNoteFile(tab, dateKey);
    if (!file) return;
    const text = await this.app.vault.read(file);
    if (text.trim().length === 0) {
      let tabMap = this.contentCache.get(tab.id);
      if (!tabMap) {
        tabMap = new Map();
        this.contentCache.set(tab.id, tabMap);
      }
      tabMap.set(dateKey, "");
      if (wasCreatedNow) {
        await this.app.vault.delete(file);
      } else {
        await this.app.fileManager.trashFile(file);
      }
      this.emit(tab.id, dateKey);
    }
  }

  /**
   * [ID 4.4.1] 지정된 폴더 경로를 볼트 루트부터 순차 생성
   * -> 새 탭 생성 시 '볼트 상단에 탭 이름으로 폴더 생성' 선택 시점에 즉시 폴더를 만들어 탐색기에서 바로 확인 가능하게 함.
   */
  async ensureFolderExists(folderPath: string): Promise<void> {
    const normalized = normalizeFolderPath(folderPath);
    if (!normalized) return;
    const segments = normalized.split("/").filter(Boolean);
    let current = "";
    for (const seg of segments) {
      current = current ? `${current}/${seg}` : seg;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (!existing) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private async ensureParentFolders(filePath: string): Promise<void> {
    const slashIdx = filePath.lastIndexOf("/");
    if (slashIdx <= 0) return;
    await this.ensureFolderExists(filePath.slice(0, slashIdx));
  }

  /**
   * 볼트 내 모든 폴더 목록을 자동완성/선택 UI용으로 반환함.
   */
  getAllVaultFolders(): string[] {
    const folders: string[] = [""];
    const collect = (folder: TFolder) => {
      for (const child of folder.children) {
        if (child instanceof TFolder) {
          folders.push(normalizeFolderPath(child.path));
          collect(child);
        }
      }
    };
    collect(this.app.vault.getRoot());
    return folders.sort((a, b) => a.localeCompare(b));
  }

  /**
   * [ID 4.5] 볼트 외부 변경(생성/수정/삭제/이름변경) 실시간 감지 핸들러
   * -> 다른 탭이나 외부 편집기에서 날짜 .md 파일을 고쳐도 캘린더 셀이 즉시 갱신되도록 함.
   */
  handleVaultFileEvent(
    file: TAbstractFile,
    eventType: "create" | "modify" | "delete" | "rename",
    oldPath?: string
  ): void {
    const tabs = this.getTabs();
    const pathsToCheck: Array<{ path: string; deleted: boolean }> = [];

    if (eventType === "rename" && oldPath) {
      pathsToCheck.push({ path: oldPath, deleted: true });
      pathsToCheck.push({ path: file.path, deleted: false });
    } else if (eventType === "delete") {
      pathsToCheck.push({ path: file.path, deleted: true });
    } else {
      pathsToCheck.push({ path: file.path, deleted: false });
    }

    for (const item of pathsToCheck) {
      if (!item.path.endsWith(".md")) continue;
      for (const tab of tabs) {
        const dateKey = parseNotePathToDateKey(
          item.path,
          tab.folderPath,
          tab.dateFormat
        );
        if (!dateKey) continue;

        let tabMap = this.contentCache.get(tab.id);
        if (!tabMap) {
          tabMap = new Map();
          this.contentCache.set(tab.id, tabMap);
        }

        if (item.deleted) {
          tabMap.set(dateKey, "");
          this.emit(tab.id, dateKey);
        } else if (file instanceof TFile) {
          void this.app.vault.cachedRead(file).then((text) => {
            tabMap!.set(dateKey, text);
            this.emit(tab.id, dateKey);
          });
        }
      }
    }
  }
}

