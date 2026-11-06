/**
 * 书架阅读器 —— browser half.
 *
 * Renders the bookshelf and the reader inside the Harness Web page: a sidebar
 * row that opens the panel, a shelf of the local books with search, sorting
 * and grouping, a scan view that adds a folder to the shelf, and a reader
 * that shows the book's paragraphs together with its illustrations.
 *
 * The browser half owns no book data of its own: every byte of it comes from
 * the plugin's host routes, and the reading position travels back to the host
 * so it survives a page reload.
 */
window.__ModuleLoader__.load({
  id: '@local/book-reader',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback, useMemo } = React;

    /** The stable id shared by the sidebar row and the main-slot page. */
    const PANEL_ID = 'book-reader';
    /** Locale namespace this plugin owns. */
    const NS = 'dsh-book-reader';
    /** Row order among the shell's global panel rows. */
    const PANEL_ORDER = 35;

    /** Route paths (document-relative: the page is served with a relative base). */
    const API = {
      scan: 'api/book-reader/scan',
      library: 'api/book-reader/library',
      add: 'api/book-reader/add',
      remove: 'api/book-reader/remove',
      book: 'api/book-reader/book',
      progress: 'api/book-reader/progress',
      image: 'api/book-reader/image',
      cover: 'api/book-reader/cover',
    };

    /** Local storage keys holding the reader's own view preferences. */
    const STORAGE = {
      fontSize: 'dsh-book-reader:font-size',
      theme: 'dsh-book-reader:theme',
      toc: 'dsh-book-reader:toc',
      sort: 'dsh-book-reader:sort',
      group: 'dsh-book-reader:group',
    };

    /** Smallest and largest type size the reader offers. */
    const FONT_MIN = 13;
    const FONT_MAX = 26;
    const FONT_DEFAULT = 17;
    /** Books the import adds per host request. */
    const BATCH_SIZE = 20;
    /** Longest one import batch may take before the client gives up on it. */
    const BATCH_TIMEOUT_MS = 120000;

    /** The ways the shelf can be ordered. */
    const SORT_KEYS = ['added', 'recent', 'name'];
    /** The ways the shelf can be grouped. */
    const GROUP_MODES = ['none', 'folder', 'author', 'format'];
    /** The badge each file format shows on the shelf. */
    const KIND_LABELS = { epub: 'EPUB', txt: 'TXT', pdf: 'PDF', docx: 'DOCX' };

    const zh = {
      'entry.label': '书架',
      'panel.title': '书架',
      'panel.count': '{count} 本本地藏书',
      'shelf.empty.title': '书架还是空的',
      'shelf.empty.hint': '扫描一个本地文件夹，把 EPUB / TXT / PDF / DOCX 书籍收进书架。文件始终留在你自己的磁盘上。',
      'shelf.empty.search': '没有匹配「{query}」的书。',
      'shelf.scan': '扫描文件夹',
      'shelf.refresh': '刷新',
      'shelf.remove': '移除',
      'shelf.read': '开始阅读',
      'shelf.continue': '继续阅读',
      'shelf.progress': '已读 {percent}%',
      'shelf.author': '作者 {author}',
      'shelf.size': '{size}',
      'shelf.failed': '读取书架失败：{error}',
      'shelf.search': '搜索书名、作者或文件名',
      'shelf.sort': '排序',
      'shelf.sort.added': '加入时间',
      'shelf.sort.recent': '最近阅读',
      'shelf.sort.name': '文件名',
      'shelf.sort.asc': '正序（点按切换）',
      'shelf.sort.desc': '倒序（点按切换）',
      'shelf.group': '分组',
      'shelf.group.none': '不分组',
      'shelf.group.folder': '按文件夹',
      'shelf.group.author': '按作者',
      'shelf.group.format': '按格式',
      'shelf.group.count': '{count} 本',
      'shelf.cover.missing': '无封面',
      'scan.title': '扫描本地文件夹',
      'scan.path.label': '文件夹绝对路径',
      'scan.path.placeholder': '例如 D:\\Books\\books',
      'scan.browse': '浏览…',
      'scan.submit': '扫描',
      'scan.cancel': '返回书架',
      'scan.found': '找到 {count} 个可读文件',
      'scan.truncated': '目录太大，只扫描了前面一部分。',
      'scan.import': '加入书架',
      'scan.selected': '已选 {count} / {total}',
      'scan.importing': '正在加入书架… {done} / {total}',
      'scan.selectAll': '全选',
      'scan.none': '这个文件夹里没有 EPUB 或 TXT 文件。',
      'scan.failed': '扫描失败：{error}',
      'scan.imported': '已加入 {count} 本，跳过 {skipped} 本。',
      'reader.back': '返回书架',
      'reader.prev': '上一章',
      'reader.next': '下一章',
      'reader.toc': '目录',
      'reader.font': '字号',
      'reader.theme': '背景',
      'reader.theme.system': '跟随主题',
      'reader.theme.paper': '护眼',
      'reader.loading': '正在打开…',
      'reader.failed': '打开失败：{error}',
      'reader.position': '第 {index} / {total} 章',
      'reader.chapters': '章节',
      'reader.empty': '这一章没有内容。',
      'reader.noText': '这个文档没有可提取的文字（扫描件没有文字层），请用其它阅读器打开。',
      'reader.imageFailed': '插图加载失败',
    };

    const en = {
      'entry.label': 'Bookshelf',
      'panel.title': 'Bookshelf',
      'panel.count': '{count} local books',
      'shelf.empty.title': 'The shelf is empty',
      'shelf.empty.hint': 'Scan a local folder to add EPUB, TXT, PDF and DOCX books to the shelf. The files stay on your own disk.',
      'shelf.empty.search': 'No book matches "{query}".',
      'shelf.scan': 'Scan folder',
      'shelf.refresh': 'Refresh',
      'shelf.remove': 'Remove',
      'shelf.read': 'Start reading',
      'shelf.continue': 'Continue',
      'shelf.progress': '{percent}% read',
      'shelf.author': 'by {author}',
      'shelf.size': '{size}',
      'shelf.failed': 'Could not load the shelf: {error}',
      'shelf.search': 'Search title, author or file name',
      'shelf.sort': 'Sort',
      'shelf.sort.added': 'Date added',
      'shelf.sort.recent': 'Recently read',
      'shelf.sort.name': 'File name',
      'shelf.sort.asc': 'Ascending (click to switch)',
      'shelf.sort.desc': 'Descending (click to switch)',
      'shelf.group': 'Group',
      'shelf.group.none': 'No grouping',
      'shelf.group.folder': 'By folder',
      'shelf.group.author': 'By author',
      'shelf.group.format': 'By format',
      'shelf.group.count': '{count} books',
      'shelf.cover.missing': 'No cover',
      'scan.title': 'Scan a local folder',
      'scan.path.label': 'Absolute folder path',
      'scan.path.placeholder': 'for example D:\\Books\\books',
      'scan.browse': 'Browse…',
      'scan.submit': 'Scan',
      'scan.cancel': 'Back to the shelf',
      'scan.found': 'Found {count} readable files',
      'scan.truncated': 'The folder is large; only its first part was scanned.',
      'scan.import': 'Add to shelf',
      'scan.selected': '{count} / {total} selected',
      'scan.importing': 'Adding to the shelf… {done} / {total}',
      'scan.selectAll': 'Select all',
      'scan.none': 'This folder holds no EPUB or TXT file.',
      'scan.failed': 'Scan failed: {error}',
      'scan.imported': 'Added {count} books, skipped {skipped}.',
      'reader.back': 'Back to the shelf',
      'reader.prev': 'Previous chapter',
      'reader.next': 'Next chapter',
      'reader.toc': 'Chapters',
      'reader.font': 'Text size',
      'reader.theme': 'Background',
      'reader.theme.system': 'Follow theme',
      'reader.theme.paper': 'Eye comfort',
      'reader.loading': 'Opening…',
      'reader.failed': 'Could not open the book: {error}',
      'reader.position': 'Chapter {index} / {total}',
      'reader.chapters': 'Chapters',
      'reader.empty': 'This chapter has no content.',
      'reader.noText': 'This document has no text layer (a scan has none), so it cannot be read here.',
      'reader.imageFailed': 'The illustration could not be loaded',
    };

    /**
     * The panel styles.
     *
     * Every color comes from a host theme token, so the panel follows the
     * application in both light and dark themes; the reading background is a
     * token layer the theme service composes, not a literal color.
     */
    const CSS = `
.nr-root{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.nr-header{flex:none;display:flex;align-items:center;gap:12px;padding:16px 20px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.nr-title{margin:0;font-size:17px;font-weight:700;color:var(--dsw-alias-label-primary)}
.nr-subtitle{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.nr-headerSpacer{flex:1}
.nr-body{flex:1;min-height:0;overflow-y:auto;padding:14px 20px 28px}
.nr-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.nr-button{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 12px;font-size:13px;cursor:pointer;line-height:1.4}
.nr-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.nr-button:disabled{opacity:.5;cursor:not-allowed}
.nr-buttonAccent{border-color:var(--dsw-alias-brand-primary)}
.nr-buttonGhost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary)}
.nr-buttonGhost:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1)}
.nr-input{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-primary);padding:6px 10px;font-size:13px;outline:none;min-width:0}
.nr-input:focus{border-color:var(--dsw-alias-brand-primary)}
.nr-select{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-primary);padding:5px 8px;font-size:12px}
.nr-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px}
.nr-search{flex:1;min-width:140px;max-width:280px}
.nr-fieldLabel{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.nr-list{display:flex;flex-direction:column;gap:10px;margin-top:4px}
.nr-card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:12px;padding:10px 12px;display:flex;align-items:center;gap:12px}
.nr-cardMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.nr-cardTitle{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nr-cardMeta{font-size:12px;color:var(--dsw-alias-label-tertiary);display:flex;gap:10px;flex-wrap:wrap}
.nr-cardActions{display:flex;align-items:center;gap:6px;flex:none}
.nr-cover{width:42px;height:60px;object-fit:cover;border-radius:4px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);flex:none}
.nr-coverFallback{width:42px;height:60px;border-radius:4px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);flex:none;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);font-size:10px;text-align:center;line-height:1.3;padding:2px}
.nr-progress{width:96px;height:4px;border-radius:2px;background:var(--dsw-alias-border-l1);overflow:hidden}
.nr-progressFill{height:100%;background:var(--dsw-alias-brand-primary)}
.nr-group{margin-top:14px}
.nr-groupHeader{display:flex;align-items:center;gap:8px;width:100%;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;padding:6px 2px;cursor:pointer;text-align:left}
.nr-groupHeader:hover{color:var(--dsw-alias-label-primary)}
.nr-groupCaret{flex:none;color:var(--dsw-alias-label-tertiary)}
.nr-groupCount{color:var(--dsw-alias-label-tertiary);font-weight:400}
.nr-empty{display:flex;flex-direction:column;align-items:center;gap:10px;padding:56px 20px;color:var(--dsw-alias-label-secondary);text-align:center}
.nr-emptyTitle{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}
.nr-emptyHint{font-size:13px;max-width:420px;line-height:1.7}
.nr-error{font-size:12px;color:var(--dsw-alias-state-error-primary);margin-top:8px;line-height:1.6}
.nr-notice{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:8px;line-height:1.6}
.nr-field{display:flex;flex-direction:column;gap:6px;margin-bottom:12px;max-width:640px}
.nr-fieldRow{display:flex;gap:8px;align-items:center}
.nr-fieldRow .nr-input{flex:1}
.nr-scanList{display:flex;flex-direction:column;gap:6px;margin-top:12px;max-width:720px}
.nr-scanRow{display:flex;align-items:center;gap:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 10px;background:var(--dsw-alias-bg-layer-1);font-size:13px}
.nr-scanName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nr-scanSize{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px}
.nr-reader{display:flex;height:100%;min-height:0;flex-direction:column}
.nr-readerBar{flex:none;display:flex;align-items:center;gap:8px;padding:12px 20px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
.nr-readerTitle{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:34%}
.nr-readerChapter{font-size:12px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.nr-readerMain{flex:1;min-height:0;display:flex}
.nr-toc{flex:none;width:230px;border-right:1px solid var(--dsw-alias-border-l1);overflow-y:auto;padding:10px 8px}
.nr-tocItem{display:block;width:100%;text-align:left;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;padding:6px 8px;border-radius:6px;cursor:pointer}
.nr-tocItem:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.nr-tocItemActive{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600}
.nr-readerContent{flex:1;min-width:0;overflow-y:auto;padding:28px 24px 60px}
.nr-prose{max-width:44em;margin:0 auto;font-size:var(--nr-font-size,17px);line-height:1.95;color:var(--dsw-alias-label-primary);word-break:break-word}
.nr-prose p{margin:0 0 1.05em;text-indent:2em}
.nr-figure{margin:1.4em 0;text-align:center}
.nr-figure img{max-width:100%;height:auto;border-radius:6px;background:var(--dsw-alias-bg-layer-2)}
.nr-figure figcaption{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-top:6px}
.nr-imageFailed{font-size:12px;color:var(--dsw-alias-label-tertiary);padding:12px;border:1px dashed var(--dsw-alias-border-l1);border-radius:6px}
.nr-readerFooter{flex:none;display:flex;align-items:center;justify-content:center;gap:14px;padding:10px 20px;border-top:1px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-tertiary)}
.nr-loading{display:flex;align-items:center;justify-content:center;height:100%;color:var(--dsw-alias-label-secondary);font-size:13px}
.nr-toggle{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}
`;

    /**
     * Call one host route.
     * @param {string} path - the route path.
     * @param {{method?: string, body?: unknown, timeoutMs?: number}} [options] - the request options.
     * @returns {Promise<any>} the parsed response.
     */
    async function request(path, options = {}) {
      const controller = new AbortController();
      const timer =
        typeof options.timeoutMs === 'number' ? setTimeout(() => controller.abort(), options.timeoutMs) : undefined;
      try {
        const headers = options.body === undefined ? new Headers() : new Headers({ 'content-type': 'application/json' });
        const response = await fetch(path, {
          method: options.method ?? 'GET',
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: controller.signal,
        });
        let payload;
        try {
          payload = await response.json();
        } catch {
          payload = undefined;
        }
        if (!response.ok) {
          const message = payload && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
          throw new Error(message);
        }
        return payload;
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error('the request timed out');
        }
        throw error;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }

    /**
     * Format a byte count.
     * @param {number} bytes - the size.
     * @returns {string} the readable size.
     */
    function formatSize(bytes) {
      const value = Number.isFinite(bytes) ? bytes : 0;
      if (value < 1024) return `${value} B`;
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
      return `${(value / 1024 / 1024).toFixed(1)} MB`;
    }

    /**
     * Read one value from local storage.
     * @param {string} key - the storage key.
     * @param {string} fallback - the value used when nothing is stored.
     * @returns {string} the stored value.
     */
    function readStored(key, fallback) {
      try {
        const value = localStorage.getItem(key);
        return value === null || value === '' ? fallback : value;
      } catch {
        return fallback;
      }
    }

    /**
     * Write one value to local storage.
     * @param {string} key - the storage key.
     * @param {string} value - the value.
     */
    function writeStored(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        // A browser that refuses storage still works for this page load.
      }
    }

    /**
     * Read the stored shelf order.
     * @returns {{key: string, desc: boolean}} the order.
     */
    function readSort() {
      try {
        const parsed = JSON.parse(readStored(STORAGE.sort, '{"key":"added","desc":true}'));
        if (typeof parsed !== 'object' || parsed === null) return { key: 'added', desc: true };
        const key = SORT_KEYS.includes(parsed.key) ? parsed.key : 'added';
        return { key, desc: parsed.desc !== false };
      } catch {
        return { key: 'added', desc: true };
      }
    }

    /**
     * The folder a book lives in, as its own name.
     * @param {object} book - the book.
     * @returns {string} the folder name.
     */
    function folderOf(book) {
      const path = String(book.path ?? '');
      const parts = path.split(/[\\/]/).filter((part) => part !== '');
      return parts.length > 1 ? parts[parts.length - 2] : path;
    }

    /**
     * The group a book belongs to.
     * @param {object} book - the book.
     * @param {string} mode - the grouping mode.
     * @returns {string} the group key.
     */
    function groupKeyOf(book, mode) {
      if (mode === 'folder') return folderOf(book);
      if (mode === 'author') return (book.author ?? '').trim() === '' ? '—' : book.author.trim();
      if (mode === 'format') return KIND_LABELS[book.kind] ?? book.kind;
      return '';
    }

    /**
     * The sidebar row glyph.
     * @param {{size?: number}} props - the shell's icon share.
     * @returns {React.ReactElement} the glyph.
     */
    function PanelIcon({ size }) {
      return h(
        'svg',
        {
          'data-dsh-panel-entry': PANEL_ID,
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: '1.3',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M2.6 3.1c1.7-.9 3.6-.9 5.4 0v9.8c-1.8-.9-3.7-.9-5.4 0z' }),
        h('path', { d: 'M13.4 3.1c-1.7-.9-3.6-.9-5.4 0v9.8c1.8-.9 3.7-.9 5.4 0z' }),
      );
    }

    /**
     * One book's cover, or a placeholder when the book has none.
     * @param {object} book - the book.
     * @param {Function} t - the translate function.
     * @returns {React.ReactElement} the cover.
     */
    function Cover({ book, t }) {
      const [failed, setFailed] = useState(false);
      useEffect(() => setFailed(false), [book.id, book.mtime]);
      if (book.cover !== true || failed) {
        return h('div', { className: 'nr-coverFallback' }, t('shelf.cover.missing'));
      }
      const source = `${API.cover}?id=${encodeURIComponent(book.id)}&v=${Math.round(book.mtime ?? 0)}`;
      return h('img', {
        className: 'nr-cover',
        src: source,
        alt: '',
        loading: 'lazy',
        onError: () => setFailed(true),
      });
    }

    /**
     * One row of the shelf.
     * @param {object} props - the row's props.
     * @returns {React.ReactElement} the row.
     */
    function BookRow({ book, t, onOpen, onRemove }) {
      const percent = Math.round((book.progress?.percent ?? 0) * 100);
      const started = percent > 0;
      return h(
        'article',
        { className: 'nr-card', key: book.id, 'data-dsh-part': 'shelf-row' },
        h(Cover, { book, t }),
        h(
          'div',
          { className: 'nr-cardMain' },
          h('div', { className: 'nr-cardTitle', title: book.title }, book.title),
          h(
            'div',
            { className: 'nr-cardMeta' },
            h('span', null, t('shelf.size', { size: formatSize(book.size) })),
            book.author ? h('span', null, t('shelf.author', { author: book.author })) : null,
            h('span', null, KIND_LABELS[book.kind] ?? book.kind),
          ),
        ),
        h(
          'div',
          { className: 'nr-cardActions' },
          h(
            'div',
            { className: 'nr-progress', title: t('shelf.progress', { percent }) },
            h('div', { className: 'nr-progressFill', style: { width: `${percent}%` } }),
          ),
          h(
            'button',
            { type: 'button', className: 'nr-button', onClick: () => onOpen(book) },
            started ? t('shelf.continue') : t('shelf.read'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'nr-button nr-buttonGhost',
              title: t('shelf.remove'),
              'aria-label': t('shelf.remove'),
              onClick: () => onRemove(book),
            },
            '✕',
          ),
        ),
      );
    }

    /**
     * The shelf: search, sorting, grouping and the books themselves.
     * @param {object} props - the view's props.
     * @returns {React.ReactElement} the shelf.
     */
    function ShelfView({ books, groups, t, error, busy, query, sort, group, collapsed, onQuery, onSort, onGroup, onToggleGroup, onScan, onOpen, onRemove }) {
      if (books.length === 0 && !busy) {
        if (query.trim() !== '') {
          return h(
            'div',
            { className: 'nr-empty' },
            h('div', { className: 'nr-emptyTitle' }, t('shelf.empty.search', { query: query.trim() })),
          );
        }
        return h(
          'div',
          { className: 'nr-empty' },
          h('div', { className: 'nr-emptyTitle' }, t('shelf.empty.title')),
          h('div', { className: 'nr-emptyHint' }, t('shelf.empty.hint')),
          h('button', { type: 'button', className: 'nr-button nr-buttonAccent', onClick: onScan }, t('shelf.scan')),
          error === undefined ? null : h('div', { className: 'nr-error' }, error),
        );
      }
      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'nr-toolbar' },
          h('input', {
            className: 'nr-input nr-search',
            type: 'search',
            value: query,
            placeholder: t('shelf.search'),
            'aria-label': t('shelf.search'),
            onChange: (event) => onQuery(event.target.value),
          }),
          h('span', { className: 'nr-fieldLabel' }, t('shelf.sort')),
          h(
            'select',
            {
              className: 'nr-select',
              value: sort.key,
              'aria-label': t('shelf.sort'),
              onChange: (event) => onSort({ key: event.target.value, desc: sort.desc }),
            },
            h('option', { value: 'added' }, t('shelf.sort.added')),
            h('option', { value: 'recent' }, t('shelf.sort.recent')),
            h('option', { value: 'name' }, t('shelf.sort.name')),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'nr-button',
              title: sort.desc ? t('shelf.sort.desc') : t('shelf.sort.asc'),
              'aria-label': sort.desc ? t('shelf.sort.desc') : t('shelf.sort.asc'),
              onClick: () => onSort({ key: sort.key, desc: !sort.desc }),
            },
            sort.desc ? '↓' : '↑',
          ),
          h('span', { className: 'nr-fieldLabel' }, t('shelf.group')),
          h(
            'select',
            {
              className: 'nr-select',
              value: group,
              'aria-label': t('shelf.group'),
              onChange: (event) => onGroup(event.target.value),
            },
            h('option', { value: 'none' }, t('shelf.group.none')),
            h('option', { value: 'folder' }, t('shelf.group.folder')),
            h('option', { value: 'author' }, t('shelf.group.author')),
            h('option', { value: 'format' }, t('shelf.group.format')),
          ),
        ),
        books.length === 0 && busy ? h('div', { className: 'nr-loading' }, t('reader.loading')) : null,
        groups.map((entry) =>
          h(
            'section',
            { className: 'nr-group', key: entry.key || 'all' },
            group === 'none'
              ? null
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'nr-groupHeader',
                    onClick: () => onToggleGroup(entry.key),
                  },
                  h('span', { className: 'nr-groupCaret' }, collapsed.has(entry.key) ? '▸' : '▾'),
                  h('span', null, entry.name),
                  h('span', { className: 'nr-groupCount' }, t('shelf.group.count', { count: entry.books.length })),
                ),
            collapsed.has(entry.key)
              ? null
              : h(
                  'div',
                  { className: 'nr-list' },
                  entry.books.map((book) => h(BookRow, { book, t, onOpen, onRemove })),
                ),
          ),
        ),
        error === undefined ? null : h('div', { className: 'nr-error' }, error),
      );
    }

    /**
     * The scan view: pick a folder, list what it holds, add the chosen books.
     * @param {object} props - the view's props.
     * @returns {React.ReactElement} the scan view.
     */
    function ScanView({ t, onCancel, onImported, pickDirectory }) {
      const [path, setPath] = useState('');
      const [found, setFound] = useState(undefined);
      const [selected, setSelected] = useState(() => new Set());
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(undefined);
      const [notice, setNotice] = useState(undefined);
      const [progress, setProgress] = useState(undefined);

      const runScan = useCallback(async () => {
        const target = path.trim();
        if (target === '') return;
        setBusy(true);
        setError(undefined);
        setNotice(undefined);
        try {
          const result = await request(`${API.scan}?path=${encodeURIComponent(target)}`);
          const books = Array.isArray(result?.books) ? result.books : [];
          setFound(books);
          setSelected(new Set(books.map((book) => book.path)));
        } catch (failure) {
          setError(t('scan.failed', { error: failure instanceof Error ? failure.message : String(failure) }));
          setFound(undefined);
        } finally {
          setBusy(false);
        }
      }, [path, t]);

      const toggle = useCallback((target) => {
        setSelected((current) => {
          const next = new Set(current);
          if (next.has(target)) next.delete(target);
          else next.add(target);
          return next;
        });
      }, []);

      const importBooks = useCallback(async () => {
        const paths = [...selected];
        if (paths.length === 0) return;
        setBusy(true);
        setError(undefined);
        setNotice(undefined);
        setProgress({ done: 0, total: paths.length });
        try {
          let books = [];
          let added = 0;
          let skipped = 0;
          // The books are added in small batches: a folder on a network share
          // takes a while per book, and a batch that reports back keeps the
          // progress visible instead of leaving one silent request running.
          for (let index = 0; index < paths.length; index += BATCH_SIZE) {
            const batch = paths.slice(index, index + BATCH_SIZE);
            const result = await request(API.add, {
              method: 'POST',
              body: { paths: batch },
              timeoutMs: BATCH_TIMEOUT_MS,
            });
            if (Array.isArray(result?.books)) books = result.books;
            if (Array.isArray(result?.added)) added += result.added.length;
            if (Array.isArray(result?.skipped)) skipped += result.skipped.length;
            setProgress({ done: Math.min(index + batch.length, paths.length), total: paths.length });
          }
          setNotice(t('scan.imported', { count: added, skipped }));
          onImported(books);
        } catch (failure) {
          setError(t('scan.failed', { error: failure instanceof Error ? failure.message : String(failure) }));
        } finally {
          setBusy(false);
          setProgress(undefined);
        }
      }, [onImported, selected, t]);

      const browse = useCallback(async () => {
        if (pickDirectory === null || pickDirectory === undefined) return;
        try {
          const chosen = await pickDirectory();
          if (typeof chosen === 'string' && chosen !== '') {
            setPath(chosen);
            setFound(undefined);
          }
        } catch {
          // The host has no native chooser: the path field stays the way in.
        }
      }, [pickDirectory]);

      const books = found ?? [];
      return h(
        'div',
        { className: 'nr-scan' },
        h('div', { className: 'nr-cardTitle' }, t('scan.title')),
        h(
          'div',
          { className: 'nr-field' },
          h('label', { className: 'nr-fieldLabel' }, t('scan.path.label')),
          h(
            'div',
            { className: 'nr-fieldRow' },
            h('input', {
              className: 'nr-input',
              value: path,
              spellCheck: false,
              placeholder: t('scan.path.placeholder'),
              onChange: (event) => setPath(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') runScan();
              },
            }),
            pickDirectory === null || pickDirectory === undefined
              ? null
              : h('button', { type: 'button', className: 'nr-button', onClick: browse }, t('scan.browse')),
            h('button', { type: 'button', className: 'nr-button nr-buttonAccent', disabled: busy, onClick: runScan }, t('scan.submit')),
          ),
        ),
        h(
          'div',
          { className: 'nr-actions' },
          h('button', { type: 'button', className: 'nr-button nr-buttonGhost', onClick: onCancel }, t('scan.cancel')),
          books.length > 0
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'nr-button',
                  disabled: busy,
                  onClick: () => setSelected(new Set(books.map((book) => book.path))),
                },
                t('scan.selectAll'),
              )
            : null,
          books.length > 0
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'nr-button nr-buttonAccent',
                  disabled: busy || selected.size === 0,
                  onClick: importBooks,
                },
                t('scan.import'),
              )
            : null,
          books.length > 0
            ? h('span', { className: 'nr-notice' }, t('scan.selected', { count: selected.size, total: books.length }))
            : null,
          progress === undefined
            ? null
            : h('span', { className: 'nr-notice' }, t('scan.importing', { done: progress.done, total: progress.total })),
        ),
        books.length > 0
          ? h(
              'div',
              { className: 'nr-scanList' },
              books.map((book) =>
                h(
                  'label',
                  { className: 'nr-scanRow', key: book.path },
                  h('input', {
                    type: 'checkbox',
                    checked: selected.has(book.path),
                    onChange: () => toggle(book.path),
                  }),
                  h('span', { className: 'nr-scanName', title: book.path }, book.name),
                  h('span', { className: 'nr-scanSize' }, formatSize(book.size)),
                ),
              ),
            )
          : null,
        found !== undefined && books.length === 0 ? h('div', { className: 'nr-notice' }, t('scan.none')) : null,
        notice === undefined ? null : h('div', { className: 'nr-notice' }, notice),
        error === undefined ? null : h('div', { className: 'nr-error' }, error),
      );
    }

    /**
     * The reader: one chapter of one book, with a chapter list beside it.
     * @param {object} props - the view's props.
     * @returns {React.ReactElement} the reader.
     */
    function ReaderView({ record, t, onBack, onProgress, themeFace }) {
      const [book, setBook] = useState(undefined);
      const [error, setError] = useState(undefined);
      const [chapter, setChapter] = useState(0);
      const [fontSize, setFontSize] = useState(() => {
        const stored = Number.parseInt(readStored(STORAGE.fontSize, `${FONT_DEFAULT}`), 10);
        return Number.isFinite(stored) ? Math.min(FONT_MAX, Math.max(FONT_MIN, stored)) : FONT_DEFAULT;
      });
      const [showToc, setShowToc] = useState(() => readStored(STORAGE.toc, '1') === '1');
      const [themeMode, setThemeMode] = useState(() => (readStored(STORAGE.theme, 'system') === 'paper' ? 'paper' : 'system'));
      const [failedImages, setFailedImages] = useState(() => new Set());
      const contentRef = useRef(null);
      const ratioRef = useRef(0);

      useEffect(() => {
        let cancelled = false;
        setBook(undefined);
        setError(undefined);
        setFailedImages(new Set());
        request(`${API.book}?id=${encodeURIComponent(record.id)}`)
          .then((payload) => {
            if (cancelled) return;
            setBook(payload);
            const chapters = Array.isArray(payload?.chapters) ? payload.chapters : [];
            const saved = record.progress?.chapter ?? 0;
            // A book usually opens on its cover page, which carries no text.
            // The reader starts at the first chapter that has something to
            // read unless the user already stopped somewhere.
            const firstWithText = chapters.findIndex((entry) =>
              (entry?.blocks ?? []).some((block) => block.t === 'p' && block.text.trim() !== ''),
            );
            const wanted =
              saved > 0 ? Math.min(saved, Math.max(0, chapters.length - 1)) : Math.max(0, firstWithText);
            setChapter(wanted);
          })
          .catch((failure) => {
            if (cancelled) return;
            setError(failure instanceof Error ? failure.message : String(failure));
          });
        return () => {
          cancelled = true;
        };
      }, [record.id]);

      useEffect(() => {
        writeStored(STORAGE.fontSize, `${fontSize}`);
      }, [fontSize]);
      useEffect(() => {
        writeStored(STORAGE.toc, showToc ? '1' : '0');
      }, [showToc]);
      useEffect(() => {
        writeStored(STORAGE.theme, themeMode);
      }, [themeMode]);

      // The reading background is a token layer over the active theme: it
      // tints the panel's own raised surfaces, so the page around it (and the
      // wallpaper behind it) keeps the host theme it had.
      useEffect(() => {
        if (themeFace === undefined || themeFace === null || typeof themeFace.overrideTokens !== 'function') return undefined;
        if (themeMode !== 'paper') return undefined;
        const layer = {
          '--dsw-alias-bg-layer-1': { light: '#f7f0e2', dark: '#221f1b' },
          '--dsw-alias-bg-layer-2': { light: '#efe5d2', dark: '#2b2721' },
        };
        try {
          const dispose = themeFace.overrideTokens('book-reader', layer);
          return () => {
            if (typeof dispose === 'function') dispose();
          };
        } catch {
          return undefined;
        }
      }, [themeFace, themeMode]);

      const chapters = useMemo(() => (Array.isArray(book?.chapters) ? book.chapters : []), [book]);
      const total = chapters.length;
      const index = Math.min(chapter, Math.max(0, total - 1));
      const current = total > 0 ? chapters[index] : undefined;

      const report = useCallback(
        (nextChapter, ratio) => {
          const percent = total > 0 ? Math.min(1, Math.max(0, (nextChapter + ratio) / total)) : 0;
          onProgress(record.id, nextChapter, percent);
        },
        [onProgress, record.id, total],
      );

      useEffect(() => {
        if (current === undefined) return;
        const node = contentRef.current;
        if (node !== null && node !== undefined) node.scrollTop = 0;
        ratioRef.current = 0;
        report(index, 0);
      }, [index, current, report]);

      const onScroll = useCallback(() => {
        const node = contentRef.current;
        if (node === null || node === undefined) return;
        const span = node.scrollHeight - node.clientHeight;
        const ratio = span > 0 ? Math.min(1, Math.max(0, node.scrollTop / span)) : 0;
        ratioRef.current = ratio;
        report(index, ratio);
      }, [index, report]);

      const step = useCallback(
        (delta) => {
          const next = Math.min(Math.max(index + delta, 0), Math.max(0, total - 1));
          if (next !== index) setChapter(next);
        },
        [index, total],
      );

      useEffect(() => {
        const onKey = (event) => {
          const target = event.target;
          if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
          if (event.key === 'ArrowLeft') step(-1);
          else if (event.key === 'ArrowRight') step(1);
          else if (event.key === 'Escape') onBack();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [onBack, step]);

      const markImageFailed = useCallback((source) => {
        setFailedImages((current) => {
          const next = new Set(current);
          next.add(source);
          return next;
        });
      }, []);

      const blocks = current?.blocks ?? [];

      return h(
        'div',
        { className: 'nr-reader' },
        h(
          'div',
          { className: 'nr-readerBar' },
          h('button', { type: 'button', className: 'nr-button nr-buttonGhost', onClick: onBack }, '‹ ' + t('reader.back')),
          h('span', { className: 'nr-readerTitle', title: book?.title ?? record.title }, book?.title ?? record.title),
          h('span', { className: 'nr-readerChapter' }, current?.title ?? ''),
          h(
            'div',
            { className: 'nr-actions' },
            h(
              'span',
              { className: 'nr-toggle' },
              t('reader.font'),
              h(
                'button',
                {
                  type: 'button',
                  className: 'nr-button',
                  'aria-label': t('reader.font'),
                  disabled: fontSize <= FONT_MIN,
                  onClick: () => setFontSize((size) => Math.max(FONT_MIN, size - 1)),
                },
                'A−',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'nr-button',
                  'aria-label': t('reader.font'),
                  disabled: fontSize >= FONT_MAX,
                  onClick: () => setFontSize((size) => Math.min(FONT_MAX, size + 1)),
                },
                'A+',
              ),
            ),
            h(
              'span',
              { className: 'nr-toggle' },
              t('reader.theme'),
              h(
                'select',
                {
                  className: 'nr-select',
                  value: themeMode,
                  'aria-label': t('reader.theme'),
                  onChange: (event) => setThemeMode(event.target.value),
                },
                h('option', { value: 'system' }, t('reader.theme.system')),
                h('option', { value: 'paper' }, t('reader.theme.paper')),
              ),
            ),
            h(
              'button',
              { type: 'button', className: 'nr-button', onClick: () => setShowToc((shown) => !shown) },
              t('reader.toc'),
            ),
          ),
        ),
        h(
          'div',
          { className: 'nr-readerMain' },
          showToc
            ? h(
                'nav',
                { className: 'nr-toc' },
                chapters.map((entry, position) =>
                  h(
                    'button',
                    {
                      type: 'button',
                      key: position,
                      className: `nr-tocItem${position === index ? ' nr-tocItemActive' : ''}`,
                      onClick: () => setChapter(position),
                    },
                    entry.title,
                  ),
                ),
              )
            : null,
          h(
            'div',
            { className: 'nr-readerContent', ref: contentRef, onScroll },
            book === undefined && error === undefined
              ? h('div', { className: 'nr-loading' }, t('reader.loading'))
              : error !== undefined
                ? h('div', { className: 'nr-error' }, t('reader.failed', { error }))
                : book?.noText === true
                  ? h('div', { className: 'nr-empty' }, h('div', { className: 'nr-emptyTitle' }, t('reader.noText')))
                  : h(
                    'div',
                    { className: 'nr-prose', style: { '--nr-font-size': `${fontSize}px` } },
                    blocks.length === 0
                      ? h('p', null, t('reader.empty'))
                      : blocks.map((block, position) =>
                          block.t === 'img'
                            ? failedImages.has(block.src)
                              ? h('div', { className: 'nr-imageFailed', key: position }, t('reader.imageFailed'))
                              : h(
                                  'figure',
                                  { className: 'nr-figure', key: position },
                                  h('img', {
                                    src: block.src,
                                    alt: block.alt ?? '',
                                    loading: 'lazy',
                                    onError: () => markImageFailed(block.src),
                                  }),
                                )
                            : h('p', { key: position }, block.text),
                        ),
                  ),
          ),
        ),
        h(
          'div',
          { className: 'nr-readerFooter' },
          h(
            'button',
            { type: 'button', className: 'nr-button', disabled: index <= 0, onClick: () => step(-1) },
            '‹ ' + t('reader.prev'),
          ),
          h('span', null, t('reader.position', { index: total > 0 ? index + 1 : 0, total })),
          h(
            'button',
            { type: 'button', className: 'nr-button', disabled: total === 0 || index >= total - 1, onClick: () => step(1) },
            t('reader.next') + ' ›',
          ),
        ),
      );
    }

    /**
     * The panel: the shelf, the scan view, and the reader.
     * @param {object} props - the panel's props.
     * @returns {React.ReactElement} the panel.
     */
    function BookReaderPanel({ t, locale, theme, pickDirectory }) {
      const [view, setView] = useState('shelf');
      const [books, setBooks] = useState([]);
      const [busy, setBusy] = useState(true);
      const [error, setError] = useState(undefined);
      const [reading, setReading] = useState(undefined);
      const [query, setQuery] = useState('');
      const [sort, setSort] = useState(readSort);
      const [group, setGroup] = useState(() => (GROUP_MODES.includes(readStored(STORAGE.group, 'none')) ? readStored(STORAGE.group, 'none') : 'none'));
      const [collapsed, setCollapsed] = useState(() => new Set());
      const [, setLocaleRevision] = useState(0);

      const load = useCallback(async () => {
        setBusy(true);
        try {
          const result = await request(API.library);
          setBooks(Array.isArray(result?.books) ? result.books : []);
          setError(undefined);
        } catch (failure) {
          setError(t('shelf.failed', { error: failure instanceof Error ? failure.message : String(failure) }));
        } finally {
          setBusy(false);
        }
      }, [t]);

      useEffect(() => {
        load();
      }, [load]);

      useEffect(() => {
        if (locale === undefined || locale === null || typeof locale.subscribe !== 'function') return undefined;
        return locale.subscribe(() => setLocaleRevision((revision) => revision + 1));
      }, [locale]);

      useEffect(() => {
        writeStored(STORAGE.sort, JSON.stringify(sort));
      }, [sort]);
      useEffect(() => {
        writeStored(STORAGE.group, group);
      }, [group]);

      const onRemove = useCallback(
        async (record) => {
          try {
            const result = await request(API.remove, { method: 'POST', body: { id: record.id } });
            setBooks(Array.isArray(result?.books) ? result.books : []);
          } catch (failure) {
            setError(t('shelf.failed', { error: failure instanceof Error ? failure.message : String(failure) }));
          }
        },
        [t],
      );

      const onProgress = useCallback((id, chapter, percent) => {
        setBooks((current) =>
          current.map((book) =>
            book.id === id ? { ...book, progress: { chapter, percent, updatedAt: Date.now() }, lastReadAt: Date.now() } : book,
          ),
        );
        request(API.progress, { method: 'POST', body: { id, chapter, percent } }).catch(() => {
          // The position is a convenience; a failed save keeps the older one.
        });
      }, []);

      const onImported = useCallback((next) => {
        setBooks(Array.isArray(next) ? next : []);
        setView('shelf');
      }, []);

      const onToggleGroup = useCallback((key) => {
        setCollapsed((current) => {
          const next = new Set(current);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
      }, []);

      const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const list =
          needle === ''
            ? [...books]
            : books.filter((book) => {
                const title = String(book.title ?? '').toLowerCase();
                const author = String(book.author ?? '').toLowerCase();
                const path = String(book.path ?? '').toLowerCase();
                return title.includes(needle) || author.includes(needle) || path.includes(needle);
              });
        const direction = sort.desc ? -1 : 1;
        list.sort((left, right) => {
          if (sort.key === 'name') {
            return direction * String(left.title ?? '').localeCompare(String(right.title ?? ''), 'zh-Hans-CN');
          }
          if (sort.key === 'recent') {
            const leftAt = left.lastReadAt ?? left.progress?.updatedAt ?? 0;
            const rightAt = right.lastReadAt ?? right.progress?.updatedAt ?? 0;
            return direction * (leftAt - rightAt);
          }
          return direction * ((left.addedAt ?? 0) - (right.addedAt ?? 0));
        });
        return list;
      }, [books, query, sort]);

      const groups = useMemo(() => {
        if (group === 'none') return [{ key: '', name: '', books: filtered }];
        const buckets = new Map();
        for (const book of filtered) {
          const key = groupKeyOf(book, group);
          const bucket = buckets.get(key);
          if (bucket === undefined) buckets.set(key, [book]);
          else bucket.push(book);
        }
        return [...buckets.entries()]
          .sort((left, right) => left[0].localeCompare(right[0], 'zh-Hans-CN'))
          .map(([key, items]) => ({ key, name: key, books: items }));
      }, [filtered, group]);

      return h(
        'div',
        { className: 'nr-root' },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        reading !== undefined
          ? h(ReaderView, {
              record: reading,
              t,
              themeFace: theme,
              onBack: () => setReading(undefined),
              onProgress,
            })
          : h(
              React.Fragment,
              null,
              h(
                'div',
                { className: 'nr-header' },
                h(
                  'div',
                  { className: 'nr-cardMain' },
                  h('h1', { className: 'nr-title' }, t('panel.title')),
                  h('span', { className: 'nr-subtitle' }, t('panel.count', { count: books.length })),
                ),
                h('div', { className: 'nr-headerSpacer' }),
                h(
                  'div',
                  { className: 'nr-actions' },
                  h('button', { type: 'button', className: 'nr-button', disabled: busy, onClick: load }, t('shelf.refresh')),
                  view === 'scan'
                    ? null
                    : h(
                        'button',
                        { type: 'button', className: 'nr-button nr-buttonAccent', onClick: () => setView('scan') },
                        t('shelf.scan'),
                      ),
                ),
              ),
              h(
                'div',
                { className: 'nr-body' },
                view === 'scan'
                  ? h(ScanView, { t, onCancel: () => setView('shelf'), onImported, pickDirectory })
                  : h(ShelfView, {
                      books: filtered,
                      groups,
                      t,
                      error,
                      busy,
                      query,
                      sort,
                      group,
                      collapsed,
                      onQuery: setQuery,
                      onSort: setSort,
                      onGroup: setGroup,
                      onToggleGroup,
                      onScan: () => setView('scan'),
                      onOpen: (book) => setReading(book),
                      onRemove,
                    }),
              ),
            ),
      );
    }

    /**
     * Register the sidebar row and the center-column page.
     * @param {object} ctx - the client context.
     * @param {Function} t - the translate function.
     * @returns {() => void} the disposer.
     */
    function registerPanel(ctx, t) {
      const slots = ctx.slots;
      const disposers = [];
      disposers.push(
        slots.inject('sidebar.panellist', () =>
          slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: PANEL_ORDER,
              label: () => t('entry.label'),
            },
            PanelIcon,
          ),
        ),
      );
      disposers.push(
        slots.inject('main', () =>
          slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              inject: () => ({
                t,
                locale: ctx.locale,
                theme: ctx.theme,
                pickDirectory:
                  ctx.uiWorkspace !== undefined && typeof ctx.uiWorkspace.pickDirectory === 'function'
                    ? () => ctx.uiWorkspace.pickDirectory()
                    : null,
              }),
            },
            BookReaderPanel,
          ),
        ),
      );
      return () => {
        for (const dispose of disposers.splice(0)) dispose();
      };
    }

    /** Services this plugin needs before it can mount its surfaces. */
    const inject = ['slots', 'locale', 'uiWorkspace', 'theme'];

    /**
     * Mount the panel.
     * @param {object} ctx - the client context.
     */
    function apply(ctx) {
      let translate;
      try {
        ctx.effect(() => {
          const disposers = [];
          for (const [id, dict] of Object.entries({ zh, en })) {
            try {
              disposers.push(ctx.locale.register(NS, id, dict));
            } catch {
              // One rejected locale does not stop the others.
            }
          }
          return () => {
            for (const dispose of disposers) dispose();
          };
        }, 'book-reader: dictionaries');
        try {
          translate = ctx.locale.bind(NS);
        } catch {
          translate = undefined;
        }
      } catch {
        translate = undefined;
      }

      /**
       * Translate one key, falling back to the bundled dictionary.
       * @param {string} key - the dictionary key.
       * @param {object} [params] - the interpolation values.
       * @returns {string} the translated text.
       */
      const t = (key, params) => {
        let text = key;
        if (typeof translate === 'function') {
          try {
            const value = translate(key);
            if (typeof value === 'string' && value !== key) text = value;
          } catch {
            // Fall through to the bundled dictionary.
          }
        }
        if (text === key) {
          let active = 'en';
          try {
            const current = ctx.locale?.getLocale?.()?.active;
            if (typeof current === 'string') active = current;
            else if (typeof document !== 'undefined') active = document.documentElement.lang || 'en';
          } catch {
            active = 'en';
          }
          const dict = active.toLowerCase().startsWith('zh') ? zh : en;
          if (typeof dict[key] === 'string') text = dict[key];
        }
        if (params !== undefined) {
          for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value));
        }
        return text;
      };

      ctx.effect(() => registerPanel(ctx, t), 'book-reader: panel');
    }

    return { apply, inject };
  },
});
