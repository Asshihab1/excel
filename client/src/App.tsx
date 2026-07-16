import { useEffect, useState, useRef, useCallback } from "react";

const API = "http://localhost:4000/api/files";
const FONT = "'Segoe UI', system-ui, -apple-system, sans-serif";
const MONO = "'Segoe UI Mono', 'Consolas', monospace";

const COLOR = {
  headerBg: "#1e293b", headerText: "#f1f5f9", headerBorder: "#334155",
  rowAlt: "#f8fafc", rowHover: "#eff6ff", border: "#e2e8f0",
  rowNumBg: "#f1f5f9", rowNumText: "#94a3b8", cellText: "#0f172a",
  cellFocusBorder: "#3b82f6", cellFocusBg: "#eff6ff",
  sidebarBg: "#f8fafc", activeFile: "#dbeafe",
  btnPrimary: "#3b82f6", btnGreen: "#16a34a", btnRed: "#ef4444",
  placeholder: "#94a3b8",
};

type Row = Record<string, string | number>;
type SheetData = Record<string, Row[]>;

type CtxMenu =
  | { kind: "file";   x: number; y: number; file: string }
  | { kind: "col";    x: number; y: number; col: string; colIdx: number }
  | { kind: "row";    x: number; y: number; rowIdx: number; isReal: boolean }
  | { kind: "cell";   x: number; y: number; rowIdx: number; colIdx: number; isReal: boolean };

type Sel = { r1: number; c1: number; r2: number; c2: number };

type CellFormat = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  bgColor?: string;
};
type SheetFmt = Record<string, CellFormat>;
type FileFmt = Record<string, SheetFmt>;

const FONT_FAMILIES = [
  { label: "Default",           value: "" },
  { label: "Arial",             value: "Arial, sans-serif" },
  { label: "Times New Roman",   value: "'Times New Roman', serif" },
  { label: "Courier New",       value: "'Courier New', monospace" },
  { label: "Georgia",           value: "Georgia, serif" },
  { label: "Verdana",           value: "Verdana, sans-serif" },
];
const FONT_SIZES = [8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 32, 36];

const TRAILING_EMPTY = 20;

function normSel(s: Sel): Sel {
  return { r1: Math.min(s.r1, s.r2), r2: Math.max(s.r1, s.r2), c1: Math.min(s.c1, s.c2), c2: Math.max(s.c1, s.c2) };
}

function CtxItem({ label, danger, onClick }: { label: string; danger?: boolean; onClick: () => void }) {
  const [hov, setHov] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: "block", width: "100%", textAlign: "left", padding: "7px 14px",
        border: "none", background: hov ? (danger ? "#fef2f2" : COLOR.rowHover) : "none",
        cursor: "pointer", fontFamily: FONT, fontSize: 12,
        color: danger ? COLOR.btnRed : COLOR.cellText,
      }}
    >
      {label}
    </button>
  );
}

function Divider() {
  return <div style={{ height: 1, background: COLOR.border, margin: "3px 0" }} />;
}

function FmtBar({ selFmt, onApply, onClear }: { selFmt: CellFormat; onApply: (p: Partial<CellFormat>) => void; onClear: () => void }) {
  const btn = (active: boolean): React.CSSProperties => ({
    width: 24, height: 24, border: `1px solid ${active ? "#3b82f6" : "#e2e8f0"}`,
    borderRadius: 3, cursor: "pointer", background: active ? "#dbeafe" : "#fff",
    display: "flex", alignItems: "center", justifyContent: "center", padding: 0, flexShrink: 0,
  });
  const sep = <div style={{ width: 1, height: 16, background: "#e2e8f0", margin: "0 2px" }} />;
  return (
    <div style={{ padding: "6px 8px", borderBottom: "1px solid #e2e8f0", display: "flex", gap: 3, alignItems: "center", flexWrap: "wrap" }}>
      <button title="Bold" style={{ ...btn(!!selFmt.bold), fontWeight: 700, fontSize: 12 }} onClick={() => onApply({ bold: !selFmt.bold })}>B</button>
      <button title="Italic" style={{ ...btn(!!selFmt.italic), fontStyle: "italic", fontSize: 12 }} onClick={() => onApply({ italic: !selFmt.italic })}>I</button>
      <button title="Underline" style={{ ...btn(!!selFmt.underline), textDecoration: "underline", fontSize: 12 }} onClick={() => onApply({ underline: !selFmt.underline })}>U</button>
      {sep}
      <select
        title="Font family"
        value={selFmt.fontFamily ?? ""}
        onChange={(e) => onApply({ fontFamily: e.target.value || undefined })}
        style={{ fontSize: 11, border: "1px solid #e2e8f0", borderRadius: 3, padding: "2px 2px", maxWidth: 90, height: 24, color: "#0f172a" }}
      >
        {FONT_FAMILIES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
      </select>
      <select
        title="Font size"
        value={selFmt.fontSize ?? ""}
        onChange={(e) => onApply({ fontSize: e.target.value ? Number(e.target.value) : undefined })}
        style={{ fontSize: 11, border: "1px solid #e2e8f0", borderRadius: 3, padding: "2px 2px", width: 46, height: 24, color: "#0f172a" }}
      >
        <option value="">sz</option>
        {FONT_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      {sep}
      <label title="Text color" style={{ position: "relative", cursor: "pointer" }}>
        <div style={{ width: 24, height: 24, borderRadius: 3, border: "1px solid #e2e8f0", background: selFmt.color ?? "#0f172a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#fff", fontWeight: 700 }}>A</div>
        <input type="color" value={selFmt.color ?? "#0f172a"} onChange={(e) => onApply({ color: e.target.value })} style={{ position: "absolute", opacity: 0, inset: 0, cursor: "pointer", width: "100%", height: "100%" }} />
      </label>
      <label title="Background color" style={{ position: "relative", cursor: "pointer" }}>
        <div style={{ width: 24, height: 24, borderRadius: 3, border: "1px solid #e2e8f0", background: selFmt.bgColor ?? "#ffffff", fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center" }}>▣</div>
        <input type="color" value={selFmt.bgColor ?? "#ffffff"} onChange={(e) => onApply({ bgColor: e.target.value })} style={{ position: "absolute", opacity: 0, inset: 0, cursor: "pointer", width: "100%", height: "100%" }} />
      </label>
      {sep}
      <button title="Clear formatting" style={{ ...btn(false), fontSize: 11, width: "auto", padding: "0 5px", color: "#94a3b8" }} onClick={onClear}>✕ fmt</button>
    </div>
  );
}

export default function App() {
  const [files, setFiles] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [sheets, setSheets] = useState<string[]>([]);
  const [activeSheet, setActiveSheet] = useState<string>("");
  const [data, setData] = useState<SheetData>({});
  const [colOrder, setColOrder] = useState<Record<string, string[]>>({});
  const [editingHeader, setEditingHeader] = useState<{ sheet: string; col: string } | null>(null);
  const [headerDraft, setHeaderDraft] = useState("");
  const [newFileName, setNewFileName] = useState("");
  const [newColName, setNewColName] = useState("");
  const [status, setStatus] = useState<{ msg: string; ok: boolean }>({ msg: "", ok: true });
  const [focusedCell, setFocusedCell] = useState<{ row: number; col: string } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const [sel, setSel] = useState<Sel | null>(null);
  const [formatting, setFormatting] = useState<FileFmt>({});
  const draggingRef = useRef(false);

  const headerInputRef = useRef<HTMLInputElement>(null);
  const tableEndRef = useRef<HTMLDivElement>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const inSel = (ri: number, ci: number) => {
    if (!sel) return false;
    const s = normSel(sel);
    return ri >= s.r1 && ri <= s.r2 && ci >= s.c1 && ci <= s.c2;
  };

  const startSel = (e: React.MouseEvent, ri: number, ci: number) => {
    if (e.button !== 0) return;
    if (e.shiftKey && sel) { setSel((p) => p ? { ...p, r2: ri, c2: ci } : { r1: ri, c1: ci, r2: ri, c2: ci }); return; }
    setSel({ r1: ri, c1: ci, r2: ri, c2: ci });
    draggingRef.current = true;
  };

  const extendSel = (ri: number, ci: number) => {
    if (!draggingRef.current) return;
    setSel((p) => p ? { ...p, r2: ri, c2: ci } : null);
  };

  useEffect(() => {
    const up = () => { draggingRef.current = false; };
    const down = (e: MouseEvent) => {
      // deselect when clicking outside the table
      if (!(e.target as HTMLElement).closest("table, .sidebar, [data-ctxmenu]")) setSel(null);
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setSel(null); };
    document.addEventListener("mouseup", up);
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mouseup", up);
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, []);

  const closeCtx = () => setCtxMenu(null);

  const openCtx = (e: React.MouseEvent, menu: CtxMenu) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu(menu);
  };

  const setStatusMsg = (msg: string, ok = true) => {
    setStatus({ msg, ok });
    setTimeout(() => setStatus({ msg: "", ok: true }), 2500);
  };

  async function loadFiles() {
    const res = await fetch(API);
    setFiles(await res.json());
  }

  async function openFile(name: string) {
    const [res, fmtRes] = await Promise.all([fetch(`${API}/${name}`), fetch(`${API}/${name}/format`)]);
    const json = await res.json();
    const fmt = await fmtRes.json();
    setActiveFile(name);
    setSheets(json.sheets);
    setActiveSheet(json.sheets[0]);
    setData(json.data);
    setColOrder(json.colOrder ?? {});
    setFormatting(fmt ?? {});
  }

  async function saveData(dataToSave: SheetData, colOrderToSave: Record<string, string[]>) {
    if (!activeFile) return;
    const cleaned: SheetData = {};
    for (const [s, rows] of Object.entries(dataToSave)) {
      let last = rows.length - 1;
      while (last >= 0 && Object.values(rows[last]).every((v) => v === "" || v === null || v === undefined)) last--;
      cleaned[s] = rows.slice(0, last + 1);
    }
    await fetch(`${API}/${activeFile}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sheets: cleaned, colOrder: colOrderToSave }),
    });
    setStatusMsg("Saved ✓");
    await openFile(activeFile!);
  }

  async function saveFile() {
    await saveData(data, colOrder);
    if (activeFile) {
      await fetch(`${API}/${activeFile}/format`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formatting),
      });
    }
  }

  const [printOpts, setPrintOpts] = useState<{
    paper: string; orientation: string; margin: string;
    fontSize: number; gridlines: boolean; zebra: boolean;
    repeatHeader: boolean; showTitle: boolean; scale: string;
  } | null>(null);

  function doPrint(opts: NonNullable<typeof printOpts>) {
    if (!activeSheet) return;
    const sheetCols = columns(activeSheet);
    const sheetRows = data[activeSheet] ?? [];
    const sheetFmt = formatting[activeSheet] ?? {};

    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const cellStyle = (ri: number, col: string) => {
      const f = sheetFmt[`${ri}:${col}`] ?? {};
      return [
        f.bold       ? "font-weight:700"           : "",
        f.italic     ? "font-style:italic"          : "",
        f.underline  ? "text-decoration:underline"  : "",
        f.fontFamily ? `font-family:${f.fontFamily}` : "",
        f.fontSize   ? `font-size:${f.fontSize}px`  : "",
        f.color      ? `color:${f.color}`            : "",
        f.bgColor    ? `background:${f.bgColor};-webkit-print-color-adjust:exact;print-color-adjust:exact` : "",
      ].filter(Boolean).join(";");
    };

    const marginMap: Record<string, string> = { none: "0", narrow: "8mm", normal: "15mm", wide: "25mm" };
    const margin = marginMap[opts.margin] ?? "15mm";
    const scaleMap: Record<string, string> = { auto: "auto", fit: "fit", "100": "100%", "90": "90%", "80": "80%", "75": "75%" };
    const scale = scaleMap[opts.scale] ?? "auto";

    const headerRow = sheetCols.map((col) => `<th>${esc(col)}</th>`).join("");
    const theadHtml = opts.repeatHeader
      ? `<thead><tr>${headerRow}</tr></thead>`
      : `<thead><tr>${headerRow}</tr></thead>`;

    const rows = sheetRows.map((row, ri) => {
      const evenStyle = opts.zebra && ri % 2 === 1 ? " class=\"alt\"" : "";
      const cells = sheetCols.map((col) => {
        const val = esc(String(row[col] ?? ""));
        const s = cellStyle(ri, col);
        return `<td${s ? ` style="${s}"` : ""}>${val}</td>`;
      }).join("");
      return `<tr${evenStyle}>${cells}</tr>`;
    }).join("");

    const borderCss = opts.gridlines
      ? "th,td { border: 1px solid #aaa; }"
      : "th,td { border: 1px solid transparent; } thead th { border-bottom: 2px solid #333; }";

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${esc(activeFile ?? "")} — ${esc(activeSheet)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Arial, sans-serif; font-size: ${opts.fontSize}px; color: #111; padding: 16px; }
  h1 { font-size: ${opts.fontSize + 3}px; font-weight: 700; margin-bottom: 3px; color: #1e293b; }
  .meta { font-size: ${opts.fontSize - 1}px; color: #64748b; margin-bottom: 14px; }
  table { border-collapse: collapse; width: 100%; table-layout: auto; }
  th { background: #1e293b; color: #f1f5f9; text-align: left; padding: 5px 8px; font-weight: 700; letter-spacing: 0.03em; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  td { padding: 4px 8px; vertical-align: middle; }
  tr.alt td { background: #f1f5f9; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  ${borderCss}
  @media print {
    body { padding: 0; }
    @page { size: ${opts.paper} ${opts.orientation}; margin: ${margin}; }
    ${scale !== "auto" && scale !== "fit" ? `html { zoom: ${scale}; }` : ""}
    ${scale === "fit" ? "table { width: 100% !important; } body { overflow: hidden; }" : ""}
    thead { display: table-header-group; }
    tfoot { display: table-footer-group; }
    tr { page-break-inside: avoid; }
  }
</style>
</head>
<body>
${opts.showTitle ? `<h1>${esc(activeFile ?? "")}</h1><p class="meta">Sheet: ${esc(activeSheet)} &nbsp;·&nbsp; ${sheetRows.length} rows &nbsp;·&nbsp; ${sheetCols.length} columns</p>` : ""}
<table>
${theadHtml}
<tbody>${rows}</tbody>
</table>
<script>window.onload = function() { window.print(); };<\/script>
</body>
</html>`;

    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const win = window.open(url, "_blank", "width=960,height=720");
    if (win) win.addEventListener("load", () => URL.revokeObjectURL(url), { once: true });
    setPrintOpts(null);
  }

  async function createFile() {
    const name = newFileName.trim();
    if (!name) return;
    const fname = name.endsWith(".xlsx") ? name : `${name}.xlsx`;
    const res = await fetch(`${API}/${fname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sheets: { Sheet1: [] } }),
    });
    if (!res.ok) { setStatusMsg("File already exists", false); return; }
    setNewFileName("");
    await loadFiles();
    openFile(fname);
  }

  async function deleteFile(name: string) {
    if (!confirm(`Delete ${name}?`)) return;
    await fetch(`${API}/${name}`, { method: "DELETE" });
    if (activeFile === name) { setActiveFile(null); setSheets([]); setData({}); setColOrder({}); }
    loadFiles();
  }

  async function renameFile(oldName: string) {
    const input = prompt("Rename file:", oldName.replace(/\.xlsx$/, ""));
    if (!input?.trim()) return;
    const newName = input.trim().endsWith(".xlsx") ? input.trim() : `${input.trim()}.xlsx`;
    const res = await fetch(`${API}/${oldName}/rename`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newName }),
    });
    const json = await res.json();
    if (!res.ok) { setStatusMsg(json.error ?? "Rename failed", false); return; }
    if (activeFile === oldName) setActiveFile(json.file);
    await loadFiles();
    setStatusMsg(`Renamed → ${json.file}`);
  }

  async function importFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${API.replace("/api/files", "")}/api/import`, { method: "POST", body: form });
    const json = await res.json();
    if (!res.ok) { setStatusMsg(json.error ?? "Import failed", false); return; }
    setStatusMsg(`Imported: ${json.file}`);
    await loadFiles();
    openFile(json.file);
    e.target.value = "";
  }

  const columns = useCallback((sheet: string) => colOrder[sheet] ?? [], [colOrder]);

  function startEditHeader(sheet: string, col: string) {
    setEditingHeader({ sheet, col });
    setHeaderDraft(col);
    setTimeout(() => { headerInputRef.current?.focus(); headerInputRef.current?.select(); }, 0);
  }

  function commitHeaderEdit() {
    if (!editingHeader) return;
    const { sheet, col } = editingHeader;
    const newName = headerDraft.trim();
    setEditingHeader(null);
    if (!newName || newName === col) return;
    setData((prev) => ({
      ...prev,
      [sheet]: (prev[sheet] ?? []).map((r) => {
        const updated: Row = {};
        for (const k of Object.keys(r)) updated[k === col ? newName : k] = r[k];
        return updated;
      }),
    }));
    setColOrder((prev) => ({
      ...prev,
      [sheet]: (prev[sheet] ?? []).map((c) => (c === col ? newName : c)),
    }));
  }

  function editCell(sheet: string, rowIdx: number, col: string, value: string) {
    setData((prev) => {
      const rows = [...(prev[sheet] ?? [])];
      while (rows.length <= rowIdx) rows.push(Object.fromEntries(columns(sheet).map((c) => [c, ""])));
      rows[rowIdx] = { ...rows[rowIdx], [col]: value };
      return { ...prev, [sheet]: rows };
    });
  }

  function addRow(sheet: string) {
    setData((prev) => {
      const empty: Row = Object.fromEntries(columns(sheet).map((c) => [c, ""]));
      return { ...prev, [sheet]: [...(prev[sheet] ?? []), empty] };
    });
    setTimeout(() => tableEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
  }

  function insertRowAt(sheet: string, idx: number) {
    setData((prev) => {
      const rows = [...(prev[sheet] ?? [])];
      const empty: Row = Object.fromEntries(columns(sheet).map((c) => [c, ""]));
      rows.splice(idx, 0, empty);
      return { ...prev, [sheet]: rows };
    });
  }

  function deleteRow(sheet: string, idx: number) {
    setData((prev) => {
      const rows = [...(prev[sheet] ?? [])];
      if (idx >= rows.length) return prev;
      rows.splice(idx, 1);
      const next = { ...prev, [sheet]: rows };
      saveData(next, colOrder);
      return next;
    });
  }

  function clearRow(sheet: string, idx: number) {
    setData((prev) => {
      const rows = [...(prev[sheet] ?? [])];
      if (idx >= rows.length) return prev;
      rows[idx] = Object.fromEntries(Object.keys(rows[idx]).map((k) => [k, ""]));
      return { ...prev, [sheet]: rows };
    });
  }

  function addColumn(sheet: string, name?: string) {
    const col = (name ?? newColName).trim();
    if (!col) return;
    if (columns(sheet).includes(col)) { setStatusMsg(`Column "${col}" exists`, false); return; }
    setData((prev) => ({ ...prev, [sheet]: (prev[sheet] ?? []).map((r) => ({ ...r, [col]: "" })) }));
    setColOrder((prev) => ({ ...prev, [sheet]: [...(prev[sheet] ?? []), col] }));
    if (!name) setNewColName("");
  }

  function insertColumnAt(sheet: string, atIdx: number) {
    const col = prompt("Column name:");
    if (!col?.trim()) return;
    if (columns(sheet).includes(col.trim())) { setStatusMsg(`Column "${col.trim()}" exists`, false); return; }
    const name = col.trim();
    setData((prev) => ({ ...prev, [sheet]: (prev[sheet] ?? []).map((r) => ({ ...r, [name]: "" })) }));
    setColOrder((prev) => {
      const order = [...(prev[sheet] ?? [])];
      order.splice(atIdx, 0, name);
      return { ...prev, [sheet]: order };
    });
  }

  function deleteColumn(sheet: string, col: string) {
    if (!confirm(`Delete column "${col}"?`)) return;
    setData((prev) => ({
      ...prev,
      [sheet]: (prev[sheet] ?? []).map((r) => { const copy = { ...r }; delete copy[col]; return copy; }),
    }));
    setColOrder((prev) => ({ ...prev, [sheet]: (prev[sheet] ?? []).filter((c) => c !== col) }));
  }

  function clearSelection(sheet: string) {
    if (!sel) return;
    const s = normSel(sel);
    const sheetCols = columns(sheet);
    setData((prev) => {
      const rows = [...(prev[sheet] ?? [])];
      for (let r = s.r1; r <= Math.min(s.r2, rows.length - 1); r++) {
        const updated = { ...rows[r] };
        for (let c = s.c1; c <= s.c2; c++) { if (sheetCols[c]) updated[sheetCols[c]] = ""; }
        rows[r] = updated;
      }
      return { ...prev, [sheet]: rows };
    });
  }

  function deleteSelectedRows(sheet: string) {
    if (!sel) return;
    const s = normSel(sel);
    setData((prev) => {
      const rows = [...(prev[sheet] ?? [])];
      const count = Math.min(s.r2, rows.length - 1) - s.r1 + 1;
      if (count <= 0) return prev;
      rows.splice(s.r1, count);
      const next = { ...prev, [sheet]: rows };
      saveData(next, colOrder);
      return next;
    });
    setSel(null);
  }

  const fmtKey = (ri: number, col: string) => `${ri}:${col}`;

  const getCellFmt = (sheet: string, ri: number, col: string): CellFormat =>
    formatting[sheet]?.[fmtKey(ri, col)] ?? {};

  function getSelFmt(sheet: string): CellFormat {
    if (!sel) return {};
    const s = normSel(sel);
    const sheetCols = columns(sheet);
    let first: CellFormat | null = null;
    let allBold = true, allItalic = true, allUnderline = true;
    for (let r = s.r1; r <= s.r2; r++) {
      for (let c = s.c1; c <= s.c2; c++) {
        const col = sheetCols[c]; if (!col) continue;
        const f = getCellFmt(sheet, r, col);
        if (!first) first = f;
        if (!f.bold) allBold = false;
        if (!f.italic) allItalic = false;
        if (!f.underline) allUnderline = false;
      }
    }
    if (!first) return {};
    return { ...first, bold: allBold, italic: allItalic, underline: allUnderline };
  }

  function applyFmt(sheet: string, patch: Partial<CellFormat>) {
    if (!sel) return;
    const s = normSel(sel);
    const sheetCols = columns(sheet);
    setFormatting((prev) => {
      const sheetFmt = { ...(prev[sheet] ?? {}) };
      for (let r = s.r1; r <= s.r2; r++) {
        for (let c = s.c1; c <= s.c2; c++) {
          const col = sheetCols[c]; if (!col) continue;
          const key = fmtKey(r, col);
          sheetFmt[key] = { ...(sheetFmt[key] ?? {}), ...patch };
        }
      }
      return { ...prev, [sheet]: sheetFmt };
    });
  }

  function clearFmt(sheet: string) {
    if (!sel) return;
    const s = normSel(sel);
    const sheetCols = columns(sheet);
    setFormatting((prev) => {
      const sheetFmt = { ...(prev[sheet] ?? {}) };
      for (let r = s.r1; r <= s.r2; r++) {
        for (let c = s.c1; c <= s.c2; c++) {
          const col = sheetCols[c]; if (!col) continue;
          delete sheetFmt[fmtKey(r, col)];
        }
      }
      return { ...prev, [sheet]: sheetFmt };
    });
  }

  function addSheet() {
    const name = prompt("Sheet name:");
    if (!name?.trim()) return;
    setData((prev) => ({ ...prev, [name]: [] }));
    setColOrder((prev) => ({ ...prev, [name]: [] }));
    setSheets((prev) => [...prev, name]);
    setActiveSheet(name);
  }

  useEffect(() => { loadFiles(); }, []);

  const cols = activeSheet ? columns(activeSheet) : [];
  const dataRows = activeSheet ? (data[activeSheet] ?? []) : [];
  const emptyRow: Row = Object.fromEntries(cols.map((c) => [c, ""]));
  const allRows = [...dataRows, ...Array(TRAILING_EMPTY).fill(emptyRow)];

  return (
    <div
      style={{ display: "flex", height: "100vh", fontFamily: FONT, fontSize: 13, color: COLOR.cellText, background: "#fff" }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* ── Sidebar ── */}
      <div className="sidebar" style={{ width: 210, borderRight: `1px solid ${COLOR.border}`, background: COLOR.sidebarBg, display: "flex", flexDirection: "column", flexShrink: 0 }}>
        <div style={{ padding: "14px 12px 8px", fontWeight: 700, fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: COLOR.rowNumText }}>
          Files
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "0 8px" }}>
          {files.map((f) => (
            <div key={f} style={{ display: "flex", alignItems: "center", gap: 2, marginBottom: 2 }}>
              <button
                onClick={() => openFile(f)}
                onContextMenu={(e) => openCtx(e, { kind: "file", x: e.clientX, y: e.clientY, file: f })}
                style={{
                  flex: 1, textAlign: "left", background: activeFile === f ? COLOR.activeFile : "transparent",
                  border: "none", cursor: "pointer", padding: "5px 8px", borderRadius: 5,
                  fontFamily: FONT, fontSize: 12, color: activeFile === f ? "#1d4ed8" : COLOR.cellText,
                  fontWeight: activeFile === f ? 600 : 400,
                }}
              >
                📄 {f}
              </button>
              <button
                onClick={() => deleteFile(f)}
                title="Delete"
                style={{ border: "none", background: "none", cursor: "pointer", color: COLOR.btnRed, padding: "2px 5px", borderRadius: 4, fontSize: 14 }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <div style={{ padding: 10, borderTop: `1px solid ${COLOR.border}`, display: "flex", flexDirection: "column", gap: 6 }}>
          <input
            placeholder="filename.xlsx"
            value={newFileName}
            onChange={(e) => setNewFileName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && createFile()}
            style={{ padding: "5px 8px", border: `1px solid ${COLOR.border}`, borderRadius: 5, fontFamily: FONT, fontSize: 12, outline: "none", color: COLOR.cellText }}
          />
          <button onClick={createFile} style={{ padding: "5px 8px", background: COLOR.btnPrimary, color: "#fff", border: "none", borderRadius: 5, cursor: "pointer", fontFamily: FONT, fontSize: 12, fontWeight: 600 }}>
            + New File
          </button>
          <input ref={importRef} type="file" accept=".xlsx,.xls" style={{ display: "none" }} onChange={importFile} />
          <button onClick={() => importRef.current?.click()} style={{ padding: "5px 8px", background: "#0ea5e9", color: "#fff", border: "none", borderRadius: 5, cursor: "pointer", fontFamily: FONT, fontSize: 12, fontWeight: 600 }}>
            ⬆ Import Excel
          </button>
        </div>
      </div>

      {/* ── Main ── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        {!activeFile ? (
          <div style={{ margin: "auto", color: COLOR.placeholder, fontFamily: FONT, fontSize: 15 }}>
            Select or create a file to get started
          </div>
        ) : (
          <>
            {/* Toolbar */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", borderBottom: `1px solid ${COLOR.border}`, background: "#fff", flexShrink: 0 }}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>{activeFile}</span>
              <button onClick={saveFile} style={{ padding: "4px 14px", background: COLOR.btnGreen, color: "#fff", border: "none", borderRadius: 5, cursor: "pointer", fontFamily: FONT, fontSize: 12, fontWeight: 600 }}>
                💾 Save
              </button>
              {status.msg && <span style={{ fontSize: 12, color: status.ok ? COLOR.btnGreen : COLOR.btnRed, fontWeight: 500 }}>{status.msg}</span>}
              <button
                onClick={() => { const a = document.createElement("a"); a.href = `${API}/${activeFile}/download`; a.download = activeFile!; a.click(); }}
                style={{ padding: "4px 14px", background: "#0ea5e9", color: "#fff", border: "none", borderRadius: 5, cursor: "pointer", fontFamily: FONT, fontSize: 12, fontWeight: 600 }}
              >
                ⬇ Export
              </button>
              <button
                onClick={() => setPrintOpts({ paper: "A4", orientation: "portrait", margin: "normal", fontSize: 12, gridlines: true, zebra: true, repeatHeader: true, showTitle: true, scale: "auto" })}
                style={{ padding: "4px 14px", background: "#64748b", color: "#fff", border: "none", borderRadius: 5, cursor: "pointer", fontFamily: FONT, fontSize: 12, fontWeight: 600 }}
              >
                🖨 Print
              </button>
              <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  placeholder="Column name"
                  value={newColName}
                  onChange={(e) => setNewColName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addColumn(activeSheet)}
                  style={{ padding: "4px 8px", border: `1px solid ${COLOR.border}`, borderRadius: 5, fontFamily: FONT, fontSize: 12, width: 130, outline: "none", color: COLOR.cellText }}
                />
                <button onClick={() => addColumn(activeSheet)} style={{ padding: "4px 12px", background: "#7c3aed", color: "#fff", border: "none", borderRadius: 5, cursor: "pointer", fontFamily: FONT, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>
                  + Column
                </button>
                <button onClick={() => addRow(activeSheet)} style={{ padding: "4px 12px", background: COLOR.btnPrimary, color: "#fff", border: "none", borderRadius: 5, cursor: "pointer", fontFamily: FONT, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>
                  + Row
                </button>
              </div>
            </div>

            {/* Sheet tabs */}
            <div style={{ display: "flex", gap: 4, padding: "6px 14px", borderBottom: `1px solid ${COLOR.border}`, background: "#f8fafc", flexShrink: 0 }}>
              {sheets.map((s) => (
                <button key={s} onClick={() => setActiveSheet(s)} style={{ padding: "3px 12px", border: `1px solid ${COLOR.border}`, borderRadius: 4, background: activeSheet === s ? COLOR.headerBg : "transparent", color: activeSheet === s ? "#fff" : COLOR.cellText, cursor: "pointer", fontFamily: FONT, fontSize: 12, fontWeight: activeSheet === s ? 600 : 400 }}>
                  {s}
                </button>
              ))}
              <button onClick={addSheet} style={{ padding: "3px 10px", border: `1px dashed ${COLOR.border}`, borderRadius: 4, cursor: "pointer", background: "transparent", fontFamily: FONT, fontSize: 12, color: COLOR.rowNumText }}>
                + Sheet
              </button>
            </div>

            {/* Table */}
            <div
              style={{ flex: 1, overflow: "auto", userSelect: "none" }}
            >
              <table style={{ borderCollapse: "collapse", minWidth: "100%", fontFamily: MONO, fontSize: 12 }}>
                <thead style={{ position: "sticky", top: 0, zIndex: 2 }}>
                  <tr>
                    <th style={{ width: 42, minWidth: 42, background: COLOR.headerBg, border: `1px solid ${COLOR.headerBorder}`, padding: "6px 4px", color: COLOR.headerText, fontSize: 11, fontFamily: FONT, fontWeight: 500 }}>#</th>
                    {cols.map((c, ci) => (
                      <th
                        key={c}
                        onMouseDown={(e) => { if (e.button !== 0) return; setSel({ r1: 0, c1: ci, r2: allRows.length - 1, c2: ci }); draggingRef.current = true; }}
                        onMouseEnter={() => { if (draggingRef.current && sel) setSel((p) => p ? { ...p, c2: ci } : null); }}
                        onContextMenu={(e) => openCtx(e, { kind: "col", x: e.clientX, y: e.clientY, col: c, colIdx: ci })}
                        style={{ background: sel && normSel(sel).c1 <= ci && ci <= normSel(sel).c2 ? "#2d4a6b" : COLOR.headerBg, border: `1px solid ${COLOR.headerBorder}`, padding: 0, minWidth: 110, position: "relative", cursor: "context-menu" }}
                      >
                        {editingHeader?.sheet === activeSheet && editingHeader.col === c ? (
                          <input
                            ref={headerInputRef}
                            value={headerDraft}
                            onChange={(e) => setHeaderDraft(e.target.value)}
                            onBlur={commitHeaderEdit}
                            onKeyDown={(e) => { if (e.key === "Enter") commitHeaderEdit(); if (e.key === "Escape") setEditingHeader(null); }}
                            style={{ width: "100%", border: "none", padding: "6px 8px", boxSizing: "border-box", fontFamily: FONT, fontSize: 12, fontWeight: 700, color: COLOR.cellText, background: "#fff", outline: `2px solid ${COLOR.cellFocusBorder}` }}
                          />
                        ) : (
                          <span
                            onDoubleClick={() => startEditHeader(activeSheet, c)}
                            title="Double-click to rename · Right-click for more"
                            style={{ display: "block", padding: "6px 8px", cursor: "text", fontFamily: FONT, fontWeight: 700, fontSize: 12, color: COLOR.headerText, letterSpacing: "0.02em", userSelect: "none" }}
                          >
                            {c}
                          </span>
                        )}
                      </th>
                    ))}
                    <th style={{ background: COLOR.headerBg, border: `1px solid ${COLOR.headerBorder}`, width: 32 }} />
                  </tr>
                </thead>
                <tbody>
                  {allRows.map((row, i) => {
                    const isReal = i < dataRows.length;
                    return (
                      <tr key={i} style={{ background: focusedCell?.row === i ? COLOR.rowHover : i % 2 === 0 ? "#fff" : COLOR.rowAlt }}>
                        {/* row number — left-click selects row, right-click = menu */}
                        <td
                          onMouseDown={(e) => { if (e.button !== 0) return; e.preventDefault(); setSel({ r1: i, c1: 0, r2: i, c2: cols.length - 1 }); draggingRef.current = true; }}
                          onMouseEnter={() => { if (draggingRef.current && sel) setSel((p) => p ? { ...p, r2: i } : null); }}
                          onContextMenu={(e) => openCtx(e, { kind: "row", x: e.clientX, y: e.clientY, rowIdx: i, isReal })}
                          style={{ border: `1px solid ${COLOR.border}`, padding: "0 4px", textAlign: "center", background: sel && normSel(sel).r1 <= i && i <= normSel(sel).r2 ? "#dbeafe" : COLOR.rowNumBg, color: COLOR.rowNumText, fontFamily: MONO, fontSize: 11, userSelect: "none", cursor: "context-menu" }}
                        >
                          {i + 1}
                        </td>
                        {cols.map((c, ci) => {
                          const selected = inSel(i, ci);
                          const focused = focusedCell?.row === i && focusedCell.col === c;
                          const fmt = getCellFmt(activeSheet, i, c);
                          return (
                            <td
                              key={c}
                              onMouseDown={(e) => { if (e.button === 0) startSel(e, i, ci); }}
                              onMouseEnter={() => extendSel(i, ci)}
                              onContextMenu={(e) => openCtx(e, { kind: "cell", x: e.clientX, y: e.clientY, rowIdx: i, colIdx: ci, isReal })}
                              style={{
                                border: selected ? "1px solid #3b82f6" : `1px solid ${COLOR.border}`,
                                padding: 0,
                                background: selected ? "#dbeafe" : (fmt.bgColor ?? "transparent"),
                              }}
                            >
                              <input
                                value={String(row[c] ?? "")}
                                onChange={(e) => editCell(activeSheet, i, c, e.target.value)}
                                onFocus={() => setFocusedCell({ row: i, col: c })}
                                onBlur={() => setFocusedCell(null)}
                                placeholder={!isReal ? "—" : ""}
                                style={{
                                  width: "100%", border: "none", padding: "5px 8px",
                                  outline: focused ? `2px solid ${COLOR.cellFocusBorder}` : "none",
                                  background: "transparent",
                                  boxSizing: "border-box",
                                  fontFamily: fmt.fontFamily ?? MONO,
                                  fontSize: fmt.fontSize ?? 12,
                                  color: fmt.color ?? COLOR.cellText,
                                  fontWeight: fmt.bold ? 700 : 400,
                                  fontStyle: fmt.italic ? "italic" : "normal",
                                  textDecoration: fmt.underline ? "underline" : "none",
                                }}
                              />
                            </td>
                          );
                        })}
                        <td style={{ border: `1px solid ${COLOR.border}`, padding: "0 4px", textAlign: "center", background: COLOR.rowNumBg }}>
                          {isReal && <button onClick={() => deleteRow(activeSheet, i)} style={{ border: "none", background: "none", cursor: "pointer", color: COLOR.btnRed, fontSize: 14, lineHeight: 1 }}>×</button>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div ref={tableEndRef} />
            </div>
          </>
        )}
      </div>

      {/* ── Context Menu ── */}
      {ctxMenu && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 99 }} onClick={closeCtx} onContextMenu={(e) => { e.preventDefault(); closeCtx(); }} />
          <div data-ctxmenu style={{
            position: "fixed", top: ctxMenu.y, left: ctxMenu.x, zIndex: 100,
            background: "#fff", border: `1px solid ${COLOR.border}`, borderRadius: 7,
            boxShadow: "0 8px 28px rgba(0,0,0,0.14)", minWidth: 180, overflow: "hidden",
            fontFamily: FONT, fontSize: 12, padding: "4px 0",
          }}>
            {ctxMenu.kind === "file" && (<>
              <CtxItem label="✏️  Rename" onClick={() => { closeCtx(); renameFile(ctxMenu.file); }} />
              <CtxItem label="📋  Open" onClick={() => { closeCtx(); openFile(ctxMenu.file); }} />
              <Divider />
              <CtxItem label="🗑  Delete" danger onClick={() => { closeCtx(); deleteFile(ctxMenu.file); }} />
            </>)}

            {ctxMenu.kind === "col" && (<>
              <CtxItem label="✏️  Rename Column" onClick={() => { closeCtx(); startEditHeader(activeSheet, ctxMenu.col); }} />
              <Divider />
              <CtxItem label="⬅  Insert Column Left"  onClick={() => { closeCtx(); insertColumnAt(activeSheet, ctxMenu.colIdx); }} />
              <CtxItem label="➡  Insert Column Right" onClick={() => { closeCtx(); insertColumnAt(activeSheet, ctxMenu.colIdx + 1); }} />
              <Divider />
              <CtxItem label="🗑  Delete Column" danger onClick={() => { closeCtx(); deleteColumn(activeSheet, ctxMenu.col); }} />
            </>)}

            {ctxMenu.kind === "row" && (<>
              <CtxItem label="⬆  Insert Row Above" onClick={() => { closeCtx(); insertRowAt(activeSheet, ctxMenu.rowIdx); }} />
              <CtxItem label="⬇  Insert Row Below" onClick={() => { closeCtx(); insertRowAt(activeSheet, ctxMenu.rowIdx + 1); }} />
              <Divider />
              <CtxItem label="🧹  Clear Row" onClick={() => { closeCtx(); clearRow(activeSheet, ctxMenu.rowIdx); }} />
              {ctxMenu.isReal && <CtxItem label="🗑  Delete Row" danger onClick={() => { closeCtx(); deleteRow(activeSheet, ctxMenu.rowIdx); }} />}
            </>)}

            {ctxMenu.kind === "cell" && (<>
              <FmtBar
                selFmt={getSelFmt(activeSheet)}
                onApply={(patch) => applyFmt(activeSheet, patch)}
                onClear={() => clearFmt(activeSheet)}
              />
              {sel && (() => { const s = normSel(sel); return s.r2 > s.r1 || s.c2 > s.c1; })() && (
                <div style={{ padding: "4px 14px 2px", fontSize: 11, color: COLOR.rowNumText, fontFamily: FONT }}>
                  {(() => { const s = normSel(sel); return `${s.r2 - s.r1 + 1} rows × ${s.c2 - s.c1 + 1} cols selected`; })()}
                </div>
              )}
              <CtxItem label="⬆  Insert Row Above" onClick={() => { closeCtx(); insertRowAt(activeSheet, ctxMenu.rowIdx); }} />
              <CtxItem label="⬇  Insert Row Below" onClick={() => { closeCtx(); insertRowAt(activeSheet, ctxMenu.rowIdx + 1); }} />
              <Divider />
              <CtxItem label="🧹  Clear Selection" onClick={() => { closeCtx(); clearSelection(activeSheet); }} />
              {ctxMenu.isReal && <CtxItem label="🗑  Delete Selected Rows" danger onClick={() => { closeCtx(); deleteSelectedRows(activeSheet); }} />}
            </>)}
          </div>
        </>
      )}

      {/* ── Print Options Modal ── */}
      {printOpts && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 199, background: "rgba(0,0,0,0.35)" }} onClick={() => setPrintOpts(null)} />
          <div style={{
            position: "fixed", zIndex: 200, top: "50%", left: "50%", transform: "translate(-50%,-50%)",
            background: "#fff", borderRadius: 10, boxShadow: "0 16px 48px rgba(0,0,0,0.22)",
            padding: "24px 28px", minWidth: 360, fontFamily: FONT, fontSize: 13, color: COLOR.cellText,
          }}>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 18 }}>🖨 Print Options</div>

            {([
              ["Paper Size", "paper", [["A4","A4"],["Letter","Letter"],["Legal","Legal"],["A3","A3"],["A5","A5"]]],
              ["Orientation", "orientation", [["Portrait","portrait"],["Landscape","landscape"]]],
              ["Margins", "margin", [["Normal","normal"],["Narrow","narrow"],["Wide","wide"],["None","none"]]],
              ["Font Size", "fontSize", [["10px","10"],["11px","11"],["12px","12"],["13px","13"],["14px","14"],["16px","16"]]],
              ["Scale", "scale", [["Auto","auto"],["Fit Width","fit"],["100%","100"],["90%","90"],["80%","80"],["75%","75"]]],
            ] as [string, string, [string,string][]][]).map(([label, key, opts]) => (
              <div key={key} style={{ display: "flex", alignItems: "center", marginBottom: 10, gap: 8 }}>
                <span style={{ width: 100, fontSize: 12, color: COLOR.rowNumText, flexShrink: 0 }}>{label}</span>
                <select
                  value={key === "fontSize" ? String(printOpts.fontSize) : (printOpts as Record<string,unknown>)[key] as string}
                  onChange={(e) => setPrintOpts((p) => p ? ({ ...p, [key]: key === "fontSize" ? Number(e.target.value) : e.target.value }) : null)}
                  style={{ flex: 1, padding: "4px 6px", border: `1px solid ${COLOR.border}`, borderRadius: 5, fontFamily: FONT, fontSize: 12, color: COLOR.cellText }}
                >
                  {opts.map(([lbl, val]) => <option key={val} value={val}>{lbl}</option>)}
                </select>
              </div>
            ))}

            <div style={{ height: 1, background: COLOR.border, margin: "12px 0" }} />

            {([
              ["Show gridlines",            "gridlines"],
              ["Alternating row colors",    "zebra"],
              ["Repeat header on each page","repeatHeader"],
              ["Show file & sheet title",   "showTitle"],
            ] as [string, string][]).map(([label, key]) => (
              <label key={key} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, cursor: "pointer", fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={(printOpts as Record<string,unknown>)[key] as boolean}
                  onChange={(e) => setPrintOpts((p) => p ? ({ ...p, [key]: e.target.checked }) : null)}
                />
                {label}
              </label>
            ))}

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 18 }}>
              <button onClick={() => setPrintOpts(null)} style={{ padding: "6px 18px", border: `1px solid ${COLOR.border}`, borderRadius: 6, cursor: "pointer", fontFamily: FONT, fontSize: 12, background: "#fff", color: COLOR.cellText }}>
                Cancel
              </button>
              <button onClick={() => doPrint(printOpts)} style={{ padding: "6px 18px", background: "#64748b", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontFamily: FONT, fontSize: 12, fontWeight: 600 }}>
                🖨 Print
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
