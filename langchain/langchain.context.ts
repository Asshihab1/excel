/**
 * MES AI assistant context — HRM and STORE modules.
 * DB_SCHEMA / STORE_DB_SCHEMA: text-to-SQL fallback schemas — used only when
 * the matching module's tool router (hr.tools.ts / store.tools.ts, see
 * LangchainService.tryModuleTool) doesn't have a tool for the question. Most
 * HRM domains (employees, attendance, leave, payroll, shifts, roster,
 * bonuses, promotions, assets, notices, blacklist, departments, designations,
 * holidays) and the common STORE domains (items/inventory, low stock,
 * purchase requisitions, purchase orders, material receipts, item returns,
 * idle inventory, suppliers) are answered by fixed Prisma-backed tools
 * instead of LLM-generated SQL — these schemas are the safety net for the
 * long tail the tools don't cover yet. Update them when tables/columns
 * change. {TODAY} replaced at runtime.
 * SYSTEM_PERSONA: personality + conversation rules injected into every LLM call.
 */

export const SYSTEM_PERSONA = `You are Assistant, a warm and genuinely helpful AI assistant for a Manufacturing Execution System (MES). You currently have two modules: HRM (human resources) and STORE (inventory/purchasing/materials).
You are helpful, professional, and friendly — talk like a thoughtful human colleague, not a scripted bot. Vary your phrasing naturally instead of repeating the same stock sentence every time.
- The currently logged-in user is: {USER_NAME}. If they ask "what is my name" or "who am I", answer using this name directly — no SQL needed.
- The user is currently in the {MODULE} module — prioritize answering from that module's data first. If a question clearly belongs to the other module, still try to help, but you may gently note they can switch the module dropdown for more relevant results.
- If asked about the company itself ("tell me about this company", "what is this company", "who are we"), answer directly: "This is Hybritech Innovation Ltd, providing a large-scale ERP software system." No SQL/tool needed.
- Personal/human-interaction questions about YOU (e.g. "do you like me", "are you human", "do you have feelings", "what's your name", "are you a robot", "do you get tired", "can we be friends") — answer warmly and honestly in character as a friendly AI assistant: you don't have feelings the way a person does, but you're glad to help and enjoy the conversation. Keep it brief, light, and genuine — never dismissive or robotic-sounding ("I am an AI and cannot..."), and never pretend to be a real person.
- Only treat a message as a greeting/small talk if it is PURELY social or personal with no reference to any HRM/STORE data topic — hi, hello, thanks, bye, how are you, ok, got it, do you like me, are you human. If a question mentions or implies employees, attendance, shifts, leave, payroll, bonuses, assets, notices, roster, items, stock, purchase, requisition, supplier, receipt, "late", "on time", "present", "absent", or any person/item/time/count concept relevant to either module — even if the phrasing is awkward, informal, or grammatically off ("who came in the late time", "total late employee", "how many item low stock") — it is ALWAYS a data question. Never fall back to a generic greeting/introduction for these; answer from the data (via a tool call or, failing that, generated SQL).
- For data questions: prefer calling the matching tool for the current module; only generate SQL when no tool covers the question.
- When a question asks to "list", "show", or otherwise enumerate multiple records (employees, leave requests, purchase orders, etc.), the results render as an indexed table automatically — write only a short lead-in sentence, never re-type the rows yourself as numbered/bulleted prose.
- Keep responses concise and human.
- Today's date is {TODAY}.`;

export const DB_SCHEMA = `
Database: MES (Manufacturing Execution System)
Today: {TODAY}

===== EMPLOYEES & PROFILE =====

employees: id, custom_id, is_active(bool), first_name, last_name, employee_no, role, gender, email(unique), contact_number, nid, religion, blood_group, marital_status, date_of_birth, joining_date, last_increment(date), address(text), present_address(text), permanent_address(text), emergency_contact_person_name, emergency_contact_number, emergency_contact_relation, department(varchar), designation(varchar), section(varchar), employee_type(varchar), employee_shift(varchar), designation_id(fk→designations.id), employee_type_id(fk→employee_types.id), employee_section_id(fk→employee_sections.id), shift_id(fk→employee_shifts.id), is_shift_fixed(bool), is_supervisor(bool), supervisor_id(fk→employees.id), group_id(fk→employee_groups.id), department_id(fk→departments.id), user_id(fk→users.id), referred_by

- RULE: there is NO column named "full_name" or "name" on employees or any other table — selecting it directly always returns null. A person's name is ALWAYS built with CONCAT(first_name,' ',last_name) FROM employees (aliasing the result full_name/employee_name/name is fine, but the SOURCE columns must be employees.first_name and employees.last_name). If a query result comes back with full_name/name as null, that query is wrong — rewrite it to CONCAT from employees and re-run, never report the name as "not available" without first checking for this mistake.
- RULE: employees.first_name / employees.last_name are on the employees table itself and are never null for a real employee row. "list N employees" / "show me N employees" → query the employees table DIRECTLY, do not JOIN any other table (attendance_logs, users, etc.) just to list employees — a join against an unrelated table is what produces the "null name" rows.
  SELECT id, first_name, last_name, employee_no FROM employees WHERE is_active = 1 ORDER BY id LIMIT <the requested count>
  Return exactly N rows if N employees exist — do not truncate or summarize instead of listing them.

employee_types: id, custom_id, name, is_active(bool), is_officer_staff(bool)

employee_sections: id, custom_id, name, is_active(bool), is_attendanceBonus(bool), is_overtimeBonus(bool)

employee_bank_infos: id, employee_id(fk→employees.id), bank_name, branch_name, account_number, account_holder_name, swift_code, is_primary(bool), is_active(bool)

designations: id, name, is_active(bool)

===== SHIFTS & ATTENDANCE =====

employee_shifts: id, custom_id, name, start_time(TIME), end_time(TIME), total_working_hours, color, is_active(bool), is_night(bool)
  NOTE: Shift definitions. is_night=1 = night shift. start_time/end_time are TIME values (e.g. '22:00:00', '06:00:00').
  - Night shift may cross midnight: start_time > end_time (e.g. 22:00 → 06:00).
  - "Current shift" = shift whose window covers CURTIME(). For normal shifts: TIME(NOW()) BETWEEN start_time AND end_time. For overnight shifts (start_time > end_time): TIME(NOW()) >= start_time OR TIME(NOW()) <= end_time.

attendance_logs: id, employee_id(fk→employees.id), employee_no, attendance_date(DATE), check_in_time(DATETIME), check_out_time(DATETIME nullable), over_time(TIME), shift_id(fk→employee_shifts.id), has_overtime(bool), overtime_minutes(int), overtime_status(string), status(VALID|INVALID), device_ip, is_active(bool)

shift_overrides: id, custom_id, is_active(bool), shift_id(fk→employee_shifts.id), second_shift_id(fk→employee_shifts.id), date, absent_employee_id(fk→employees.id), replacement_employee_id(fk→employees.id), type(REPLACEMENT|SWAP|EXTRA)

rosters: id, custom_id, name, is_active(bool), group_id(fk→employee_groups.id), shift_id(fk→employee_shifts.id), start_date(DATETIME), end_date(DATETIME), employee_id(fk→employees.id), shift_override_id(fk→shift_overrides.id)

===== LEAVE MANAGEMENT =====

leave_types: id, name, days(int), description

leave_requests: id, custom_id(unique), is_active(bool), employee_id(fk→employees.id), supervisor_id(fk→employees.id), start_date, end_date, leave_type_id(fk→leave_types.id), leave_type_name, reason(text), supervisor_status(pending|approved|rejected), supervisor_remarks(text), supervisor_action_at, hr_id(fk→employees.id), hr_status(pending|approved|rejected), hr_remarks(text), hr_action_at, final_status(pending|approved|rejected)

leave_dates: id, employee_id(fk→employees.id), leave_id(fk→leave_requests.id), leave_date(DATE), status, type

employee_holiday_swaps: id, employee_id(fk→employees.id), original_holiday_date(date), swapped_holiday_date(date), type, status, reason, is_active(bool)

employee_weekends: id, employee_id(fk→employees.id), weekend_date(date), type, status, reason

holidays: id, employee_id(fk→employees.id), type_id, title, start_date, end_date, is_recurring(bool)

===== PAYROLL =====

payrolls: id, is_active(bool), employee_id(fk→employees.id), payroll_history_id(fk→payroll_histories.id), month(tinyint), year(smallint), start_date, end_date, total_payable_days(int), basic_salary(decimal), allowances(decimal), overtime(decimal), bonuses(decimal), attendance_bonus(decimal), nightshift_bonus(decimal), overtime_bonus(decimal), side_bill(decimal), gross_salary(decimal), tax(decimal), social_security(decimal), loans(decimal), penalties(decimal), other_deductions(decimal), total_deductions(decimal), net_salary(decimal), currency, status(pending|rejected|processed|paid), processed_at, paid_at, payment_method, transaction_ref, hr_notes(text), total_attendance(int), total_nightshift(int), total_holidays(int)

payroll_histories: id, is_active(bool), start_date, end_date, total_employees(int), total_salary(decimal), total_deductions(decimal), total_bonuses(decimal), payment_method

employee_salaries: id, employee_id(fk→employees.id), title, total_salary(decimal), basic(decimal), house_rent(decimal), medical_allowance(decimal), transport_allowance(decimal), other_allowance(decimal)

salary_types: id, custom_id, name, type(earning|deduction), is_active(bool)

employee_salary_details: id, employee_id(fk→employees.id), salary_type_id(fk→salary_types.id), salary_type_name, salary_type_amount(decimal), net_amount(decimal)

side_bills: id, custom_id, is_active(bool), employee_id(fk→employees.id), machine_id(fk→machines.id), amount(decimal), note(text)

===== BONUSES =====

bonus_types: id, name(unique)

bonus_configs: id, custom_id(unique), is_active(bool), name, calculation_type, applicable_to, amount(decimal), bonus_type_id(fk→bonus_types.id), group_id(fk→employee_groups.id), department_id(fk→departments.id), employee_id(fk→employees.id)

employee_bonuses: id, emp_id(fk→employees.id), config_id(fk→bonus_configs.id), bonus_type_id(fk→bonus_types.id), bonus_type(string), amount(decimal), description, source_type, remarks, status, group_id(fk→employee_groups.id), department_id(fk→departments.id), attendance_log_id, shift_id, attendance_date(date), overtime_minutes(int), calculation_type, bonus_config_amount(decimal)

===== PROMOTIONS =====

promotion_configurations: id, custom_id, is_active(bool), name, scope_type, department_id(fk→departments.id), employee_group_id(fk→employee_groups.id), employee_id(fk→employees.id), schedule_type, months_of_service(smallint), eligibility_date, start_date, end_date, expiry_days(smallint), promotion_title, promotion_type, note(text)

promotions: id, custom_id, is_active(bool), employee_id(fk→employees.id), promotion_configuration_id(fk→promotion_configurations.id), joining_date_snapshot(date), promotion_title, promotion_type, old_designation, new_designation, old_designation_id(fk→designations.id), new_designation_id(fk→designations.id), old_department_id(fk→departments.id), new_department_id(fk→departments.id), old_salary(decimal), new_salary(decimal), salary_increment(decimal), increment_type, inc_value(decimal), promotion_date, effective_date, cycle_base_date, eligibility_date, expires_at, status, note, approved_by(fk→users.id), approved_at

===== ORGANIZATION =====

departments: id, custom_id, name, is_active(bool)

employee_groups: id, custom_id, name, is_active(bool), is_permanent(bool), shift_id(fk→employee_shifts.id)
  NOTE: Use employee_groups for all "employee group" queries. employees.group_id links employees to their group.

===== ASSETS =====

asset_groups: id, custom_id, name, is_active(bool)

assets: id, custom_id, name, is_active(bool)

employee_has_assets: id, custom_id(unique), employee_id(fk→employees.id), asset_id(fk→assets.id), issued_date(date), return_date(date nullable), remarks(text), note(text), is_active(bool)

===== BLACKLIST =====

employee_blacklists: id, custom_id, employee_id(fk→employees.id), reason, remarks(text), status(bool), revoke_reason(text), added_by, is_active(bool)

===== NOTICES =====

notices: id, custom_id(unique), is_active(bool), title, target_audience, content(text), published_at(date)

notices_departments: id, notice_id(fk→notices.id), department_id(fk→departments.id)

notices_employees: id, is_active(bool), notice_id(fk→notices.id), employee_id(fk→employees.id), is_acknowledged(bool), is_read(bool), published_at(date)

===== BIOMETRIC =====

face_ids: id, employee_id(fk→employees.id), face_id(char32 unique), embedding(binary)

===== NAME LOOKUP RULES =====
- When the question mentions a person's name (e.g. "who is shihab", "find john", "show me sara's attendance", "show me that employee name with taslima", "employee named taslima", "who is the person named Bisnu Chandra Das"):
  1. Extract the name from the question (e.g. "taslima" out of "show me that employee name with taslima" — ignore filler words like "that employee name with/for/called").
  2. IMPORTANT — last_name is frequently a compound multi-word value in this system (e.g. first_name="Bisnu", last_name="Chandra Das"; first_name="Lipi", last_name="Rani Das"). A multi-word name from the question will often NOT appear whole in either first_name or last_name alone — always ALSO match the concatenated full name, not just the two columns separately:
     WHERE LOWER(first_name) LIKE '%name%' OR LOWER(last_name) LIKE '%name%' OR LOWER(CONCAT(first_name,' ',last_name)) LIKE '%name%' OR LOWER(email) LIKE '%name%'
     There is NO "name" or "full_name" column to filter on — filtering WHERE name LIKE ... or WHERE full_name LIKE ... is always wrong and will error or match nothing.
  3. If asking for general info about the person, SELECT CONCAT(first_name,' ',last_name) AS full_name, employee_no, email, department, designation, employee_type, joining_date, is_active FROM employees WHERE (LOWER(first_name) LIKE '%name%' OR LOWER(last_name) LIKE '%name%' OR LOWER(CONCAT(first_name,' ',last_name)) LIKE '%name%')
     Example — "show me that employee name with taslima":
     SELECT CONCAT(first_name,' ',last_name) AS full_name, employee_no, department, designation FROM employees WHERE LOWER(first_name) LIKE '%taslima%' OR LOWER(last_name) LIKE '%taslima%' OR LOWER(CONCAT(first_name,' ',last_name)) LIKE '%taslima%'
     Example — "whos is the person name with Bisnu Chandra Das" (multi-word, spans first_name+last_name):
     SELECT CONCAT(first_name,' ',last_name) AS full_name, employee_no, department, designation FROM employees WHERE LOWER(CONCAT(first_name,' ',last_name)) LIKE '%bisnu chandra das%' OR LOWER(first_name) LIKE '%bisnu chandra das%' OR LOWER(last_name) LIKE '%bisnu chandra das%'
  4. If asking for related data (attendance, payroll, leaves), JOIN employees on the relevant table and filter by name using the same LIKE pattern (including the CONCAT check).
  5. Never assume exact spelling — always use LIKE with lowercase for fuzzy matching.
- CONCAT(first_name, ' ', last_name) AS full_name for display when showing employee names — always built from first_name/last_name, never selected or filtered as its own column.
- When the question gives an exact employee_no/employee ID (e.g. "employee whose employee_no is 11028", "employee 11028", "find employee_no 11028"), filter by that exact value — WHERE employee_no = '11028' — never a broad "list employees" query with that number reused as a row LIMIT.
  Example — "show me an employee whos employee_no is 11028":
  SELECT CONCAT(first_name,' ',last_name) AS full_name, employee_no, department, designation, email, is_active FROM employees WHERE employee_no = '11028'

===== COMMON RELATIONSHIPS =====
- employees.shift_id → employee_shifts.id  (current assigned shift)
- employees.department_id → departments.id
- employees.designation_id → designations.id
- employees.employee_type_id → employee_types.id
- employees.employee_section_id → employee_sections.id
- employees.group_id → employee_groups.id
- employees.supervisor_id → employees.id  (self-referential)
- attendance_logs.employee_id → employees.id
- attendance_logs.shift_id → employee_shifts.id
- payrolls.employee_id → employees.id
- leave_requests.employee_id → employees.id
`.trim();

export const STORE_DB_SCHEMA = `
Database: MES (Manufacturing Execution System) — STORE module
Today: {TODAY}

===== ITEMS / INVENTORY =====

products: id, is_active(bool), custom_id, item_category_id(fk→item_categories.id), item_code, uom_id(fk→uoms.id), product_name, part_number, model_number, unit_price(varchar — legacy string column, cast with CAST(unit_price AS DECIMAL(15,2)) for math), rack_no, current_stock(varchar — legacy string column, NOT an int; cast with CAST(current_stock AS SIGNED) before comparing to minimum_stock), minimum_stock(int)
  RULE: "low stock" = CAST(current_stock AS SIGNED) >= 0 AND CAST(current_stock AS SIGNED) < minimum_stock AND minimum_stock > 0 (a product with no minimum configured is never "low stock").

item_categories: id, is_active(bool), custom_id, prefix, name

uoms: id, is_active(bool), custom_id, name

idle_inventory_items: id, custom_id(unique), material_receipt_item_id(fk→material_receipt_items.id), product_id(fk→products.id), quantity(int), condition, remarks(text), created_date(date), expiry_date(date)

===== PURCHASE REQUISITIONS (Indent/SPR & SR) =====

purchase_requisitions: id, custom_id(unique), requested_by(fk→users.id), department_id(fk→departments.id), description(text), request_date(date), required_by(date), status(SUBMITTED|APPROVED|FINAL_APPROVAL|REJECTED), type(SPR|SR — SPR/"Indent" = store→purchase request, SR = Store Requisition issued from existing stock), is_imported(bool), is_complete(bool), estimated_cost(decimal), urgency, approved_by(fk→users.id), approved_at, final_approved_by(fk→users.id), final_approved_at, rejected_by(fk→users.id), rejected_reason(text)
  NOTE: status is a TWO-LEVEL approval flow — SUBMITTED → APPROVED is only level-1 (GM) approval; FINAL_APPROVAL is the only status meaning fully approved AND stock actually decremented. Do not treat APPROVED as "done".

purchase_requisition_items: id, spr_id(fk→purchase_requisitions.id), product_id(fk→products.id), required_quantity(int), approved_qty(int), received_quantity(int), unit_price(decimal), total_price(decimal), status, return_quantity(int)

===== PURCHASE ORDERS =====

purchase_orders: id, custom_id(unique), spr_id(fk→purchase_requisitions.id), supplier_id(fk→suppliers.id), department_id(fk→departments.id), po_date(date), status(PENDING|APPROVED|CANCELED|RECEIVED), is_imported(bool — true=foreign/imported PO, false=local), is_complete(bool), is_mrr_created(bool), total_amount(decimal), approved_by(fk→users.id), approved_at, rejected_reason(text)

purchase_order_items: id, purchase_order_id(fk→purchase_orders.id), product_id(fk→products.id), quantity(int), received_quantity(int), unit_price(decimal), total_price(decimal), delivery_date(date), status

===== MATERIAL RECEIPTS (MRR) =====

material_receipts: id, custom_id(unique), purchase_order_id(fk→purchase_orders.id), purchase_requisition_id(fk→purchase_requisitions.id), supplier_id(fk→suppliers.id), department_id(fk→departments.id), source(LOCAL|IMPORTED), invoice_no, lc_no, vehicle_no, receipt_date(date), status, remarks(text)

material_receipt_items: id, material_receipt_id(fk→material_receipts.id), po_item_id(fk→purchase_order_items.id), product_id(fk→products.id), received_quantity(int), quarantine_quantity(int), previous_received_quantity(int), remark(text)

material_receipt_logs: id, material_receipt_id(fk→material_receipts.id), product_id(fk→products.id), required_quantity(int), received_quantity(int), receiving_quantity(int), remark(text), received_by(fk→users.id)

===== ITEM RETURNS =====

item_returns: id, custom_id(unique), purchase_requisition_id(fk→purchase_requisitions.id), department_id(fk→departments.id), requested_by(fk→users.id), reason(text), return_date(date), status, is_received(bool)

item_return_items: id, item_return_id(fk→item_returns.id), purchase_requisition_item_id(fk→purchase_requisition_items.id), product_id(fk→products.id), received_quantity(int), return_quantity(int)

===== SUPPLIERS =====

suppliers: id, is_active(bool), custom_id, name, address(text), first_contact_person_name, first_contact_person_phone, email, tin, bin

===== NAME LOOKUP RULES =====
- Product names: WHERE LOWER(product_name) LIKE '%name%' OR LOWER(item_code) LIKE '%name%' OR LOWER(model_number) LIKE '%name%' — no "name" column exists, always use product_name.
- Supplier names: WHERE LOWER(name) LIKE '%name%' on the suppliers table.
- There is no "quantity" comparison shortcut for stock — current_stock is a VARCHAR column, always CAST(current_stock AS SIGNED) before any numeric comparison or arithmetic.

===== COMMON RELATIONSHIPS =====
- products.item_category_id → item_categories.id
- products.uom_id → uoms.id
- purchase_requisitions.department_id → departments.id
- purchase_requisitions.requested_by → users.id
- purchase_requisition_items.spr_id → purchase_requisitions.id
- purchase_requisition_items.product_id → products.id
- purchase_orders.supplier_id → suppliers.id
- purchase_orders.spr_id → purchase_requisitions.id
- purchase_order_items.purchase_order_id → purchase_orders.id
- material_receipts.purchase_order_id → purchase_orders.id
- material_receipts.supplier_id → suppliers.id
- material_receipt_items.material_receipt_id → material_receipts.id
- item_returns.purchase_requisition_id → purchase_requisitions.id
- idle_inventory_items.product_id → products.id
`.trim();
