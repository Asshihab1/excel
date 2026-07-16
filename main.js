require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const multer = require("multer");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const FILES_DIR = path.join(__dirname, "xlsx-files");

const upload = multer({
  storage: multer.diskStorage({
    destination: FILES_DIR,
    filename: (_req, file, cb) => {
      // keep original name, avoid overwrite by suffixing timestamp if exists
      const dest = path.join(FILES_DIR, file.originalname);
      if (fs.existsSync(dest)) {
        const ext = path.extname(file.originalname);
        const base = path.basename(file.originalname, ext);
        cb(null, `${base}_${Date.now()}${ext}`);
      } else {
        cb(null, file.originalname);
      }
    },
  }),
  fileFilter: (_req, file, cb) => {
    const ok = file.originalname.endsWith(".xlsx") || file.originalname.endsWith(".xls");
    cb(null, ok);
  },
});

// POST /api/import — upload any .xlsx/.xls file into FILES_DIR
app.post("/api/import", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No valid xlsx/xls file uploaded" });
  res.json({ ok: true, file: req.file.filename });
});

// GET /api/files — list all xlsx files
app.get("/api/files", (_req, res) => {
  const files = fs.readdirSync(FILES_DIR).filter((f) => f.endsWith(".xlsx"));
  res.json(files);
});

// GET /api/files/:name — read file, return sheets as JSON
app.get("/api/files/:name", (req, res) => {
  const filePath = path.join(FILES_DIR, req.params.name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });

  const wb = XLSX.readFile(filePath);
  const result = {};
  const colOrder = {};
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    // extract header row to get true column order
    const headers = XLSX.utils.sheet_to_json(ws, { header: 1 })[0] ?? [];
    colOrder[sheetName] = headers.map(String);
    result[sheetName] = XLSX.utils.sheet_to_json(ws, { defval: "" });
  }
  res.json({ sheets: wb.SheetNames, data: result, colOrder });
});

// POST /api/files/:name — create new xlsx file with optional initial data
// Body: { sheets: { SheetName: [ { col: val, ... }, ... ] } }
app.post("/api/files/:name", (req, res) => {
  const filePath = path.join(FILES_DIR, req.params.name);
  if (fs.existsSync(filePath)) return res.status(409).json({ error: "File already exists" });

  const wb = XLSX.utils.book_new();
  const sheets = req.body?.sheets || { Sheet1: [] };
  for (const [sheetName, rows] of Object.entries(sheets)) {
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }
  XLSX.writeFile(wb, filePath);
  res.json({ ok: true, file: req.params.name });
});

// PUT /api/files/:name — save/overwrite file with new data
// Body: { sheets: { SheetName: [...rows] }, colOrder: { SheetName: [...cols] } }
app.put("/api/files/:name", (req, res) => {
  const filePath = path.join(FILES_DIR, req.params.name);
  const { sheets, colOrder } = req.body ?? {};
  if (!sheets) return res.status(400).json({ error: "Missing sheets in body" });

  const wb = XLSX.utils.book_new();
  for (const [sheetName, rows] of Object.entries(sheets)) {
    const cols = colOrder?.[sheetName];
    const opts = cols?.length ? { header: cols } : {};
    const ws = XLSX.utils.json_to_sheet(rows, opts);
    // if rows is empty but we have column headers, write them manually
    if (!rows.length && cols?.length) {
      XLSX.utils.sheet_add_aoa(ws, [cols], { origin: "A1" });
      ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 0, c: cols.length - 1 } });
    }
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }
  XLSX.writeFile(wb, filePath);
  res.json({ ok: true, file: req.params.name });
});

// PATCH /api/files/:name/rename — rename file
// Body: { newName: "new-name.xlsx" }
app.patch("/api/files/:name/rename", (req, res) => {
  const oldPath = path.join(FILES_DIR, req.params.name);
  if (!fs.existsSync(oldPath)) return res.status(404).json({ error: "File not found" });
  let { newName } = req.body;
  if (!newName) return res.status(400).json({ error: "newName required" });
  if (!newName.endsWith(".xlsx")) newName += ".xlsx";
  const newPath = path.join(FILES_DIR, newName);
  if (fs.existsSync(newPath)) return res.status(409).json({ error: "Name already taken" });
  fs.renameSync(oldPath, newPath);
  const oldFmt = oldPath + ".fmt.json";
  if (fs.existsSync(oldFmt)) fs.renameSync(oldFmt, newPath + ".fmt.json");
  res.json({ ok: true, file: newName });
});

// GET /api/files/:name/download — send raw .xlsx file
app.get("/api/files/:name/download", (req, res) => {
  const filePath = path.join(FILES_DIR, req.params.name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${req.params.name}"`);
  res.sendFile(filePath);
});

// GET /api/files/:name/format — load cell formatting sidecar
app.get("/api/files/:name/format", (req, res) => {
  const fmtPath = path.join(FILES_DIR, req.params.name + ".fmt.json");
  if (!fs.existsSync(fmtPath)) return res.json({});
  res.json(JSON.parse(fs.readFileSync(fmtPath, "utf8")));
});

// PUT /api/files/:name/format — save cell formatting sidecar
app.put("/api/files/:name/format", (req, res) => {
  const fmtPath = path.join(FILES_DIR, req.params.name + ".fmt.json");
  fs.writeFileSync(fmtPath, JSON.stringify(req.body ?? {}));
  res.json({ ok: true });
});

// DELETE /api/files/:name — delete file
app.delete("/api/files/:name", (req, res) => {
  const filePath = path.join(FILES_DIR, req.params.name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });
  fs.unlinkSync(filePath);
  const fmtPath = filePath + ".fmt.json";
  if (fs.existsSync(fmtPath)) fs.unlinkSync(fmtPath);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`xlsx server running on port ${PORT}`));
