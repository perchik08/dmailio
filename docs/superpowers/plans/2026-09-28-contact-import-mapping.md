# Contact Import Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one CSV/XLSX import wizard that maps arbitrary columns to contact fields, template variables and campaign steps, previews validation and duplicate outcomes, then imports the reviewed result.

**Architecture:** Format readers produce one positional `ParsedTable` contract. A pure mapping/normalization module builds the preview and validates every row; the same server path recomputes it at confirmation and passes only accepted contacts to the store's transaction. The browser wizard selects a workbook sheet, edits mappings and shows the preview before saving.

**Tech Stack:** Node.js 24+, native Node test runner, `csv-parse`, ExcelJS 4.4.0 for `.xlsx` reading, existing HTTP server, SQLite store, browser JavaScript.

**Spec:** `docs/superpowers/specs/2026-09-28-contact-import-mapping-design.md`

## Global Constraints

- Accept CSV and `.xlsx`, limit each file to 10 MB and each import to 10,000 contacts; reject `.xls` with a save-as-`.xlsx` message.
- One selected worksheet per workbook; never execute formulas or macros; use saved displayed/cached cell values.
- Require exactly one mapped Email column; keep syntax validation local and do not call an external address-validation service.
- Preserve positional column IDs, source row numbers, duplicate-column names, existing campaign variables and campaign-scoped email uniqueness.
- Show duplicate reasons for records already in any campaign available to this account; default to skipping previously imported contacts.
- Preview is read-only; confirmation is atomic for lead rows and repeat-safe; existing campaign steps are not silently replaced.

## Review Focus

- Repeated CSV/XLSX headers with independent values: assert both columns survive with distinct IDs and can map to different sequence steps.
- CSV quoted multiline cells and blank lines: assert every error points to the correct source record and values remain intact.
- XLSX dates, leading-zero values and formula cells with/without cached results: assert readable saved values are preserved and missing results are reported rather than calculated.
- Workbook with multiple, empty, malformed or oversized sheets: assert explicit sheet/error behavior and no campaign mutation.
- Duplicate emails within the file, current campaign and another account-visible campaign, plus a failed import: assert preview reasons, default skip behavior and zero partial inserts.

---

### Task 1: Read CSV and Excel into the shared table contract

**Files:**
- Create: `outreach/import-table.mjs`
- Modify: `outreach/package.json`, `outreach/package-lock.json`
- Test: `outreach/test/import-table.test.mjs`
- Keep compatibility: `outreach/core.mjs`, `outreach/test/core.test.mjs`

**Interfaces:**
- Produce `parseCsvTable(text) -> ParsedTable`.
- Produce `listXlsxSheets(buffer) -> Promise<SheetInfo[]>` and `parseXlsxSheet(buffer, sheetId) -> Promise<ParsedTable>`.
- `ParsedTable` is `{ format, sheetId, sheetName, columns: [{ id, position, header, samples }], rows: [{ sourceRow, values }] }`; `id` is positional and unique even when headers repeat.
- Add `exceljs@4.4.0`; use cached formula results only (ExcelJS is not a calculation engine).

- [ ] **Step 1: Write failing reader tests** for UTF-8/BOM and quoted CSV, repeated headers, blank-line source rows, workbook sheet listing/selection, displayed cell values including leading-zero formatting, formula cached result/no cached result, and empty workbook/sheet behavior.
- [ ] **Step 2: Run `npm test -- --test-name-pattern="table reader"` from `outreach/`** and confirm new tests fail because the reader module is missing.
- [ ] **Step 3: Add `exceljs@4.4.0` and implement the three reader functions** with a 10 MB input guard, 10,000-contact limit, unique positional IDs, bounded samples, and clear errors for `.xls`, malformed or empty sheets. Preserve `parseContacts()` through an adapter until the server migration is complete.
- [ ] **Step 4: Run `node --test test/import-table.test.mjs test/core.test.mjs` from `outreach/`** and confirm all reader and legacy CSV tests pass.
- [ ] **Step 5: Commit** as `feat: read CSV and XLSX import tables`.

### Task 2: Map fields and normalize import previews

**Files:**
- Create: `outreach/import.mjs`
- Modify: `outreach/core.mjs`
- Test: `outreach/test/import.test.mjs`, `outreach/test/core.test.mjs`

**Interfaces:**
- Produce `suggestColumnMappings(columns) -> ColumnMapping[]`.
- Produce `previewImport(table, mappings, { existingEmails, skipExisting }) -> ImportPreview`.
- `ColumnMapping` is `{ columnId, target, variableName? }`; targets are the standard field keys, `custom`, `sequence_subject`, `{ kind: "sequence_step", step }`, and `skip`.
- `ImportPreview` contains normalized `contacts`, `steps`, `variables`, per-row `errors` and `skipped` reasons, and import/skip/error counts.

- [ ] **Step 1: Write failing mapping tests** for Russian/English header suggestions, exactly one Email target, conflicting standard fields and step targets, custom-name validation, all standard fields, no automatic full-name split, step 1–20 mapping, duplicate source headers, local email syntax checks, within-file duplicate reasons, and missing mapped values.
- [ ] **Step 2: Run `node --test test/import.test.mjs` from `outreach/`** and confirm the new tests fail.
- [ ] **Step 3: Implement the pure mapping and preview functions**; preserve old template tokens for existing CSV headers while exposing stable mapped variables; use positional column IDs to bind values and return source-row diagnostics.
- [ ] **Step 4: Run `node --test test/import.test.mjs test/core.test.mjs` from `outreach/`** and confirm mapping and legacy render behavior pass.
- [ ] **Step 5: Commit** as `feat: map import columns to contact fields`.

### Task 3: Expose preview and atomic campaign import APIs

**Files:**
- Modify: `outreach/server.mjs`, `outreach/store.mjs`
- Test: `outreach/test/server.test.mjs`, `outreach/test/store.test.mjs`

**Interfaces:**
- Keep `POST /api/import/preview`; accept `{ format, content, sheetId?, mappings?, campaignId?, skipExisting? }`. For XLSX, `content` is base64; for CSV, it is UTF-8 text. Return sheet/column metadata before mapping and an `ImportPreview` after mapping.
- Update `POST /api/campaigns/:id/import` to accept the same immutable source and mappings, recompute the same preview on the server, reject invalid mapping/file state, and import accepted rows only.
- Add a store query that returns normalized addresses already present in campaigns visible to this account, and use existing `importContacts(id, contacts)` transaction/unique constraint for final persistence.
- Allow up to 14,000,000 bytes only on these two import routes for base64 expansion of a 10 MB workbook; retain the existing 11,000,000-byte cap elsewhere.

- [ ] **Step 1: Write failing API/store tests** for no-write preview, selected-sheet preview, route-specific request caps, account-visible duplicate classification, skip on/off, draft-only import, and transaction rollback/retry behavior.
- [ ] **Step 2: Run `node --test test/server.test.mjs test/store.test.mjs` from `outreach/`** and verify the new cases fail.
- [ ] **Step 3: Implement reader-to-preview routing and duplicate lookup**; require an authenticated same-origin request as today, keep preview read-only, and call the existing transactional store only after server-side revalidation.
- [ ] **Step 4: Run `node --test test/server.test.mjs test/store.test.mjs test/import.test.mjs` from `outreach/`** and confirm all API/store cases pass.
- [ ] **Step 5: Commit** as `feat: validate and import mapped contacts`.

### Task 4: Build the browser import wizard

**Files:**
- Create: `outreach/public/importer.js`
- Modify: `outreach/public/app.js`, `outreach/public/index.html`, `outreach/public/style.css`
- Test: `outreach/test/import-ui.test.mjs` (focused pure UI-state/mapping tests, without duplicating DOM implementation)

**Interfaces:**
- Consume `POST /api/import/preview` sheet/column responses and `ImportPreview` from Task 3.
- Emit final `{ format, content, sheetId, mappings, skipExisting }` to `POST /api/campaigns/:id/import` only after explicit user confirmation.
- Expose selected fields/variables to the sequence editor; show and require explicit confirmation before replacing existing steps.

- [ ] **Step 1: Write failing UI-state tests** for file type/size handling, workbook sheet selection, default suggestions, duplicate header labels with position, missing Email blocking, preview refresh after mapping changes, existing-chain replacement confirmation, and exact user copy for both empty-sheet cases.
- [ ] **Step 2: Run `node --test test/import-ui.test.mjs` from `outreach/`** and verify the tests fail.
- [ ] **Step 3: Implement the three wizard views**: choose file/sheet, map columns with sample values and “Не импортировать”, then review contacts/errors/duplicates/steps. Support CSV and `.xlsx`; retain source data and mappings when navigating back; only confirm to import.
- [ ] **Step 4: Run `node --test test/import-ui.test.mjs test/server.test.mjs` from `outreach/`** and verify preview-to-import state is consistent.
- [ ] **Step 5: Commit** as `feat: add mapped contact import wizard`.

### Task 5: Verify acceptance and update operator documentation

**Files:**
- Modify: `outreach/README.md`, `outreach/test/import-table.test.mjs`, `outreach/test/import.test.mjs`, `outreach/test/server.test.mjs`

**Interfaces:**
- Document supported formats, limits, mapping behavior, exact empty-sheet messages, local email syntax validation, and the fact that address existence is not checked.
- No new runtime interface.

- [ ] **Step 1: Add end-to-end acceptance fixtures** for the supplied header pattern (`Направление`, `Компания`, `Почта`, repeated `Письмо 1`, `Письмо 2`) and equivalent CSV/XLSX data.
- [ ] **Step 2: Run `npm test` from `outreach/`** and confirm all tests pass.
- [ ] **Step 3: Run `npm run format:check` from `outreach/`** and resolve any format failures.
- [ ] **Step 4: Review the diff against the spec**: verify legacy templates, draft-only behavior, no external validation, import caps, preview parity, empty-sheet copy, and atomic lead rows.
- [ ] **Step 5: Commit** as `test: cover mapped CSV and XLSX imports`.
