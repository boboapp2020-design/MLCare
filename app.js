/* ============================================================
   MLCare - Application logic (รองรับฐานข้อมูลจริง + ออฟไลน์)
   ============================================================ */
(function () {
  "use strict";

  var LS_RECORDS = "mlcare_records";
  var LS_SESSION = "mlcare_session";
  var LS_QUEUE = "mlcare_queue";

  var USE_API = (typeof API_URL !== "undefined" && API_URL && ("" + API_URL).trim() !== "");
  var API = USE_API ? ("" + API_URL).trim() : "";

  /* คลังข้อมูล (เริ่มจากไฟล์ในเครื่องเป็น fallback แล้วทับด้วยข้อมูลจากชีต) */
  var DB = {
    nurses:    (typeof NURSES    !== "undefined") ? NURSES.slice()    : [],
    employees: (typeof EMPLOYEES !== "undefined") ? EMPLOYEES.slice() : [],
    medicines: (typeof MEDICINES !== "undefined") ? MEDICINES.slice() : [],
    symptoms:  (typeof SYMPTOMS  !== "undefined") ? SYMPTOMS.slice()  : []
  };
  /* map ยา -> อาการ (จาก data.js) ใช้ตรวจ "ยาตรงกับอาการ" กับยาที่ดึงจากชีต */
  var SYMPTOM_MAP = {};
  if (typeof MEDICINES !== "undefined") MEDICINES.forEach(function (m) { SYMPTOM_MAP[m.name] = m.symptoms || []; });
  function attachSymptoms(list) {
    return list.map(function (m) {
      return { name: m.name, unit: m.unit, treats: m.treats, symptoms: m.symptoms || SYMPTOM_MAP[m.name] || [] };
    });
  }

  var currentNurse = null, currentEmp = null, lastRecords = [], submitting = false, empMode = "emp";

  /* ---------- helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function show(el) { el.classList.remove("hidden"); }
  function hide(el) { el.classList.add("hidden"); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function toast(msg) {
    var t = $("toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(t._h); t._h = setTimeout(function () { t.classList.remove("show"); }, 2600);
  }
  function loadRecords() { try { return JSON.parse(localStorage.getItem(LS_RECORDS)) || []; } catch (e) { return []; } }
  function saveRecords(l) { localStorage.setItem(LS_RECORDS, JSON.stringify(l)); }

  /* ---------- API ---------- */
  var TOKEN = (typeof API_TOKEN !== "undefined" && API_TOKEN) ? ("" + API_TOKEN) : "";
  function apiGet(action, params) {
    var u = API + (API.indexOf("?") < 0 ? "?" : "&") + "action=" + encodeURIComponent(action);
    if (params) for (var k in params) if (params.hasOwnProperty(k)) u += "&" + k + "=" + encodeURIComponent(params[k]);
    if (TOKEN) u += "&token=" + encodeURIComponent(TOKEN);
    return fetch(u, { method: "GET" }).then(function (r) { return r.json(); });
  }
  function apiPost(action, payload) {
    var body = { action: action, payload: payload };
    if (TOKEN) body.token = TOKEN;
    return fetch(API, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); });
  }

  /* ---------- data store (API หรือ localStorage) ---------- */
  function bootstrapData() {
    if (!USE_API) return Promise.resolve();
    return apiGet("bootstrap").then(function (res) {
      if (!res || !res.ok) throw new Error((res && res.error) || "bootstrap failed");
      if (res.users && res.users.length)         DB.nurses = res.users;
      if (res.employees && res.employees.length) DB.employees = res.employees;
      if (res.medicines && res.medicines.length) DB.medicines = attachSymptoms(res.medicines).filter(function (m) { return !/ไม่จ่าย|ไม่ได้จ่าย/.test(m.name); });
      if (res.symptoms && res.symptoms.length)   DB.symptoms = res.symptoms;
    });
  }
  function storeAddRecord(rec) {
    if (USE_API) {
      if (!rec.code) rec.code = genCode().code;   // สร้างโค้ดล่วงหน้า (ให้ตรงกันแม้ออฟไลน์)
      return apiPost("addRecord", rec).then(function (res) {
        if (res && res.ok) return res;
        throw new Error((res && res.error) || "save failed");   // error ทางธุรกิจ (สต๊อกไม่พอ) → ไม่เข้าคิว
      }, function () {
        queueRecord(rec);                                        // เน็ตหลุด → เก็บเข้าคิว
        return { ok: true, code: rec.code, offline: true };
      });
    }
    var gen = genCode();
    rec.code = gen.code; rec.nurseCode = currentNurse.code;
    rec.datetime = new Date().toISOString();
    var recs = loadRecords(); recs.push(rec); saveRecords(recs);
    return Promise.resolve({ ok: true, code: gen.code });
  }

  /* ---------- คิวออฟไลน์ (#7) ---------- */
  function loadQueue() { try { return JSON.parse(localStorage.getItem(LS_QUEUE)) || []; } catch (e) { return []; } }
  function saveQueue(q) { localStorage.setItem(LS_QUEUE, JSON.stringify(q)); }
  function queueRecord(rec) { var q = loadQueue(); q.push(rec); saveQueue(q); updateQueueBadge(); }
  function updateQueueBadge() {
    var el = $("queue-badge"); if (!el) return;
    var n = loadQueue().length;
    if (n > 0) { el.textContent = "⏳ รอส่ง " + n; show(el); } else hide(el);
  }
  function syncQueue() {
    if (!USE_API) return;
    var q = loadQueue(); if (!q.length) return;
    var rec = q[0];
    apiPost("addRecord", rec).then(function (res) {
      var qq = loadQueue();
      if (res && res.ok) { qq.shift(); saveQueue(qq); updateQueueBadge(); toast("ซิงค์บันทึก " + rec.code + " แล้ว"); syncQueue(); }
      else { qq.shift(); saveQueue(qq); updateQueueBadge(); toast("ข้ามรายการซิงค์ไม่ได้: " + ((res && res.error) || "")); syncQueue(); }
    }, function () { /* ยังออฟไลน์ — เก็บไว้ก่อน */ });
  }
  function storeListRecords() {
    if (USE_API) return apiGet("records").then(function (res) { return (res && res.records) || []; });
    return Promise.resolve(loadRecords());
  }
  function storeDeleteRecord(code, pin) {
    if (USE_API) return apiPost("deleteRecord", { code: code, pin: pin }).then(function (res) {
      if (!res || !res.ok) throw new Error((res && res.error) || "ลบไม่สำเร็จ"); return res;
    });
    if (!currentNurse || String(currentNurse.pin) !== String(pin)) return Promise.reject(new Error("PIN ไม่ถูกต้อง"));
    saveRecords(loadRecords().filter(function (r) { return r.code !== code; }));
    return Promise.resolve({ ok: true });
  }
  function storeUpdateRecord(code, data) {
    var by = currentNurse ? currentNurse.name : "admin";
    if (USE_API) return apiPost("updateRecord", { code: code, symptom: data.symptom, note: data.note, pin: data.pin, by: by }).then(function (res) {
      if (!res || !res.ok) throw new Error((res && res.error) || "แก้ไขไม่สำเร็จ"); return res;
    });
    if (!currentNurse || String(currentNurse.pin) !== String(data.pin)) return Promise.reject(new Error("PIN ไม่ถูกต้อง"));
    saveRecords(loadRecords().map(function (r) { if (r.code === code) { r.symptom = data.symptom; r.note = data.note; r.status = "✎ แก้ไข"; } return r; }));
    return Promise.resolve({ ok: true });
  }
  function storeChangePin(currentPin, newPin) {
    if (USE_API) return apiPost("changePin", { badge: currentNurse.badge, currentPin: currentPin, newPin: newPin }).then(function (res) {
      if (!res || !res.ok) throw new Error((res && res.error) || "เปลี่ยน PIN ไม่สำเร็จ"); return res;
    });
    if (String(currentNurse.pin) !== String(currentPin)) return Promise.reject(new Error("PIN ปัจจุบันไม่ถูกต้อง"));
    return Promise.resolve({ ok: true });   // ออฟไลน์: อัปเดตเฉพาะ session
  }
  function openSettings() {
    if (!currentNurse) return;
    $("pinchg-who").textContent = currentNurse.name + " • Badge " + currentNurse.badge;
    $("pinchg-cur").value = ""; $("pinchg-new").value = ""; $("pinchg-new2").value = ""; $("pinchg-err").textContent = "";
    show($("pinchg-modal")); setTimeout(function () { $("pinchg-cur").focus(); }, 50);
  }
  function savePinChange() {
    var cur = $("pinchg-cur").value.trim(), n1 = $("pinchg-new").value.trim(), n2 = $("pinchg-new2").value.trim();
    if (!cur) { $("pinchg-err").textContent = "กรุณากรอก PIN ปัจจุบัน"; return; }
    if (!/^\d{4,}$/.test(n1)) { $("pinchg-err").textContent = "PIN ใหม่ต้องเป็นตัวเลขอย่างน้อย 4 หลัก"; return; }
    if (n1 !== n2) { $("pinchg-err").textContent = "ยืนยัน PIN ใหม่ไม่ตรงกัน"; return; }
    if (n1 === cur) { $("pinchg-err").textContent = "PIN ใหม่ต้องต่างจากเดิม"; return; }
    var btn = $("pinchg-ok"); btn.disabled = true; $("pinchg-err").textContent = "กำลังบันทึก…";
    storeChangePin(cur, n1).then(function () {
      currentNurse.pin = n1;
      localStorage.setItem(LS_SESSION, JSON.stringify(currentNurse));
      btn.disabled = false; hide($("pinchg-modal")); toast("เปลี่ยน PIN เรียบร้อยแล้ว");
    }).catch(function (e) { btn.disabled = false; $("pinchg-err").textContent = e.message || "เปลี่ยน PIN ไม่สำเร็จ"; });
  }

  function storeClearRecords(pin) {
    if (USE_API) return apiPost("clearRecords", { pin: pin }).then(function (res) {
      if (!res || !res.ok) throw new Error((res && res.error) || "ล้างไม่สำเร็จ"); return res;
    });
    if (!currentNurse || String(currentNurse.pin) !== String(pin)) return Promise.reject(new Error("PIN ไม่ถูกต้อง"));
    var n = loadRecords().length; saveRecords([]);
    return Promise.resolve({ ok: true, cleared: n });
  }

  /* ---------- LOGIN ---------- */
  function norm(s) { return ("" + (s || "")).trim().toLowerCase().replace(/\s+/g, " "); }
  /* เข้าระบบด้วย Badge + Pin */
  function findNurse(badge, pin) {
    var b = norm(badge), p = norm(pin);
    for (var i = 0; i < DB.nurses.length; i++) {
      var u = DB.nurses[i];
      if (norm(u.badge) === b && norm(u.pin) === p) return u;
    }
    return null;
  }
  function doLogin(e) {
    e.preventDefault();
    var badge = $("login-name").value, pin = $("login-badge").value;
    if (!badge.trim() || !pin.trim()) { $("login-error").textContent = "กรุณากรอก Badge ID และ Pin"; return; }
    var nurse = findNurse(badge, pin);
    if (!nurse) { $("login-error").textContent = "Badge ID หรือ Pin ไม่ถูกต้อง"; return; }
    $("login-error").textContent = "";
    startSession(nurse);
  }
  function startSession(nurse) {
    currentNurse = nurse;
    localStorage.setItem(LS_SESSION, JSON.stringify(nurse));
    $("who-name").textContent = nurse.name;
    $("nurse-locked").value = nurse.name;
    hide($("view-login")); show($("view-app"));
    resetForm();
    setupRole(isAdminRole(nurse.role));
  }
  /* แสดง/ซ่อนแท็บตามบทบาท: admin = แดชบอร์ด/ประวัติ/วิเคราะห์/สต๊อก (ไม่มีหน้าบันทึก) */
  function setupRole(admin) {
    var tabs = document.querySelectorAll(".tab[data-role]");
    for (var i = 0; i < tabs.length; i++) {
      var forAdmin = tabs[i].dataset.role === "admin";
      tabs[i].classList.toggle("hidden", forAdmin !== admin);
    }
    var small = document.querySelector(".topbar-right .who small");
    if (small) small.innerHTML = admin ? "ผู้ดูแลระบบ • Admin" : ("พยาบาลผู้ให้บริการ • รหัส " + esc(currentNurse.code));
    document.body.classList.toggle("is-admin", admin);
    adminData.loaded = false;
    switchTab(admin ? "dashboard" : "record");
  }
  function logout() {
    localStorage.removeItem(LS_SESSION); currentNurse = null;
    $("login-form").reset(); $("login-error").textContent = "";
    hide($("view-app")); show($("view-login"));
  }

  /* ---------- โหมด พนักงาน / ผู้รับเหมา ---------- */
  function setEmpMode(mode) {
    empMode = mode;
    var isC = mode === "contractor";
    var btns = document.querySelectorAll(".emode-btn");
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle("active", btns[i].dataset.mode === mode);
    $("emp-card-title").textContent = isC ? "ข้อมูลผู้รับเหมา" : "ข้อมูลพนักงาน";
    $("emp-desc").textContent = isC
      ? "กรอกข้อมูลผู้รับเหมา (ผู้รับเหมาไม่มีรหัสพนักงาน — กรอกเอง)"
      : "กรอกรหัสพนักงานแล้วกด “เลือก” ระบบจะดึงข้อมูลขึ้นมาอัตโนมัติ (หรือกด “ค้นหา” เพื่อหาตามชื่อ/หน่วยงาน)";
    $("emp-lookup").classList.toggle("hidden", isC);
    $("contractor-fields").classList.toggle("hidden", !isC);
    $("emp-search-more").classList.toggle("hidden", isC);
    currentEmp = null; hide($("emp-box")); hide($("history-card")); hide($("contractor-box")); $("emp-error").textContent = "";
  }
  function confirmContractor() {
    var cf = { first: $("c-first").value.trim(), last: $("c-last").value.trim(), age: $("c-age").value.trim(), company: $("c-company").value.trim() };
    if (!cf.first || !cf.last) { toast("กรุณากรอกชื่อ-นามสกุล"); $("c-first").focus(); return; }
    if (!cf.age) { toast("กรุณากรอกอายุ"); $("c-age").focus(); return; }
    if (!cf.company) { toast("กรุณากรอกบริษัทผู้รับเหมา"); $("c-company").focus(); return; }
    currentEmp = { id: "รับเหมา", firstName: cf.first, lastName: cf.last, age: cf.age, gender: "-", prefix: "", engName: "",
      position: "ผู้รับเหมา", sector: "-", division: "-", department: cf.company, group: "ผู้รับเหมา" };
    $("cb-name").textContent = cf.first + " " + cf.last;
    $("cb-age").textContent = cf.age + " ปี";
    $("cb-company").textContent = cf.company;
    show($("contractor-box"));
    toast("ยืนยันข้อมูลผู้รับเหมาแล้ว");
  }
  function clearContractor() {
    $("c-first").value = ""; $("c-last").value = ""; $("c-age").value = ""; $("c-company").value = "";
    currentEmp = null; hide($("contractor-box")); $("c-first").focus();
  }

  /* ---------- ค้นหาพนักงาน (ด้วยรหัส) ---------- */
  function findEmpById(id) {
    for (var i = 0; i < DB.employees.length; i++) if (DB.employees[i].id === id) return DB.employees[i];
    return null;
  }
  function renderEmployee(emp) {
    currentEmp = emp;
    $("e-id").textContent = emp.id;
    $("e-prefix").textContent = emp.prefix || "-";
    $("e-name").textContent = (emp.firstName || "") + " " + (emp.lastName || "");
    $("e-eng").textContent = emp.engName || "-";
    $("e-gender").innerHTML = '<span class="badge-gender ' + (emp.gender === "ชาย" ? "g-male" : emp.gender === "หญิง" ? "g-female" : "") + '">' + esc(emp.gender || "-") + "</span>";
    $("e-birth").textContent = emp.birth || "-";
    $("e-age").textContent = emp.age ? emp.age + " ปี" : "-";
    $("e-pos").textContent = emp.position || "-";
    $("e-sector").textContent = emp.sector || "-";
    $("e-div").textContent = emp.division || "-";
    $("e-dept").textContent = emp.department || "-";
    $("e-group").textContent = emp.group || "-";
    show($("emp-box"));
    loadEmpHistory(emp.id);
  }

  /* ---------- ประวัติรายบุคคล ---------- */
  function loadEmpHistory(empId) {
    show($("history-card"));
    var box = $("emp-history");
    box.innerHTML = '<div class="empty">กำลังโหลด…</div>';
    $("history-sub").textContent = "ประวัติการเข้าห้องพยาบาลของพนักงานคนนี้";
    var p = USE_API
      ? apiGet("history", { empId: empId }).then(function (res) { return (res && res.records) || []; })
      : Promise.resolve(loadRecords().filter(function (r) { return r.empId === empId; }));
    p.then(renderEmpHistory).catch(function () {
      box.innerHTML = '<div class="empty">โหลดประวัติไม่สำเร็จ</div>';
    });
  }
  function renderEmpHistory(list) {
    var box = $("emp-history");
    $("history-sub").textContent = "เข้าใช้บริการทั้งหมด " + list.length + " ครั้ง";
    if (!list.length) { box.innerHTML = '<div class="empty">— ยังไม่มีประวัติการใช้บริการ —</div>'; return; }
    box.innerHTML = list.slice().reverse().map(function (r) {
      return '<div class="hist-item">' +
        '<div class="hist-top"><span class="hist-date">' + esc(fmtDate(r.datetime)) + '</span>' +
        '<span class="hist-code">' + esc(r.code) + '</span></div>' +
        '<div class="hist-sym">' + esc(r.symptom) + '</div>' +
        '<div class="hist-med">💊 ' + esc(medsToText(r)) + '</div>' +
        '</div>';
    }).join("");
  }
  function selectEmployee() {
    var q = $("emp-search").value.trim(), err = $("emp-error");
    if (!q) { err.textContent = "กรุณากรอกรหัสพนักงาน"; return; }
    var emp = findEmpById(q);
    if (!emp) {
      err.textContent = "❌ ไม่พบพนักงานรหัส “" + q + "” กรุณาตรวจสอบรหัสให้ถูกต้อง";
      hide($("emp-box")); currentEmp = null;
      toast("ไม่พบพนักงานรหัส " + q);
      $("emp-search").focus(); $("emp-search").select();
      hide($("history-card"));
      return;
    }
    err.textContent = ""; renderEmployee(emp);
  }
  /* เลือกพนักงานจากผลค้นหา -> ดึงเข้าหน้าบันทึก */
  function pickEmployee(id) {
    var emp = findEmpById(id); if (!emp) return;
    $("emp-search").value = emp.id; $("emp-error").textContent = "";
    renderEmployee(emp);
    switchTab("record");
    window.scrollTo({ top: 0, behavior: "smooth" });
    toast("เลือกพนักงาน " + emp.id + " แล้ว");
  }

  /* ---------- ค้นหารายชื่อ / หน่วยงาน ---------- */
  function resultRow(emp, cols) {
    var tds = cols.map(function (c) { return "<td>" + esc(c) + "</td>"; }).join("");
    return "<tr>" + tds + '<td class="pick-cell"><button type="button" class="btn-pick" data-id="' + esc(emp.id) + '">เลือก</button></td></tr>';
  }
  function searchByName() {
    var q = norm($("search-name-input").value), body = $("search-name-results"), empty = $("search-name-empty");
    body.innerHTML = "";
    if (!q) { empty.textContent = "พิมพ์ชื่อเพื่อค้นหา…"; show(empty); return; }
    var matches = DB.employees.filter(function (e) {
      return norm((e.firstName || "") + " " + (e.lastName || "")).indexOf(q) >= 0;
    });
    if (!matches.length) { empty.textContent = "ไม่พบชื่อที่ตรงกับ “" + $("search-name-input").value.trim() + "”"; show(empty); return; }
    hide(empty);
    var lim = matches.slice(0, 200);
    body.innerHTML = lim.map(function (e) {
      return resultRow(e, [e.id, (e.firstName || "") + " " + (e.lastName || ""), e.department || "-", e.position || "-"]);
    }).join("");
    if (matches.length > 200) { show(empty); empty.textContent = "แสดง 200 จาก " + matches.length + " รายการ — พิมพ์ให้เฉพาะเจาะจงขึ้น"; }
  }
  var deptsFilled = false;
  function populateDepts() {
    if (deptsFilled) return;
    var set = {}; DB.employees.forEach(function (e) { if (e.department) set[e.department] = true; });
    var depts = Object.keys(set).sort();
    var sel = $("search-dept-select");
    depts.forEach(function (d) { var o = document.createElement("option"); o.value = d; o.textContent = d; sel.appendChild(o); });
    deptsFilled = true;
  }
  function searchByDept() {
    var d = $("search-dept-select").value, body = $("search-dept-results"), empty = $("search-dept-empty");
    body.innerHTML = "";
    if (!d) { empty.textContent = "เลือกแผนกเพื่อแสดงรายชื่อ…"; show(empty); return; }
    var matches = DB.employees.filter(function (e) { return e.department === d; });
    if (!matches.length) { empty.textContent = "ไม่มีพนักงานในแผนกนี้"; show(empty); return; }
    hide(empty);
    body.innerHTML = matches.map(function (e) {
      return resultRow(e, [e.id, (e.firstName || "") + " " + (e.lastName || ""), e.position || "-", e.division || "-"]);
    }).join("");
  }

  /* ---------- อาการ dropdown ---------- */
  function isOther(v) { return /อื่น/.test(v || ""); }
  /* สร้าง options อาการ — "อื่น ๆ" อยู่ล่างสุดเสมอ (ใช้ซ้ำได้หลาย select) */
  function buildSymptomOptions(sel) {
    if (!sel) return;
    var keep = sel.value;
    sel.innerHTML = '<option value="">— เลือกอาการ —</option>';
    var otherLabel = null;
    DB.symptoms.forEach(function (s) {
      if (isOther(s)) { if (!otherLabel) otherLabel = s; return; }
      var o = document.createElement("option"); o.value = s; o.textContent = s; sel.appendChild(o);
    });
    var ol = otherLabel || "อื่น ๆ";
    var oo = document.createElement("option"); oo.value = ol; oo.textContent = ol; sel.appendChild(oo);
    if (keep) sel.value = keep;
  }
  function populateSymptoms() { buildSymptomOptions($("symptom")); }
  function onSymptomChange() {
    var sel = $("symptom");
    if (isOther(sel.value)) show($("symptom-other"));
    else { hide($("symptom-other")); $("symptom-other").value = ""; }
    refreshMedHints();
  }
  function baseSymptom() { return $("symptom").value; }
  function resolvedSymptom() {
    var s = $("symptom").value;
    if (isOther(s)) { var o = $("symptom-other").value.trim(); return o ? s + ": " + o : s; }
    return s;
  }

  /* ---------- รายการยา ---------- */
  function medOptionsHTML() {
    var h = '<option value="">— เลือกยา —</option><option value="none">🚫 ไม่จ่ายยา</option>';
    DB.medicines.forEach(function (m, i) { h += '<option value="' + i + '">' + esc(m.name) + " (" + esc(m.unit) + ")</option>"; });
    return h;
  }
  function addMedLine(idx, qty) {
    var wrap = document.createElement("div");
    wrap.className = "med-line";
    wrap.innerHTML =
      '<div class="m-name"><select class="inp med-name">' + medOptionsHTML() + '</select></div>' +
      '<div class="m-qty"><input class="inp med-qty" type="number" min="1" placeholder="จำนวน"><span class="unit-chip med-unit">หน่วย</span></div>' +
      '<button type="button" class="m-del" title="ลบ">✕</button>' +
      '<div class="med-hint"></div>';
    var sel = wrap.querySelector(".med-name");
    if (idx != null) sel.value = idx;
    wrap.querySelector(".med-qty").value = qty || "";
    sel.addEventListener("change", function () { updateMedLine(wrap); });
    wrap.querySelector(".m-del").addEventListener("click", function () {
      wrap.remove();
      if ($("med-list").children.length === 0) addMedLine();
      updateAddBtn();
    });
    $("med-list").appendChild(wrap);
    updateMedLine(wrap);
  }
  function updateMedLine(wrap) {
    var sel = wrap.querySelector(".med-name"),
        unitEl = wrap.querySelector(".med-unit"),
        qtyEl = wrap.querySelector(".med-qty"),
        hint = wrap.querySelector(".med-hint"),
        idx = sel.value;
    if (idx === "") {
      unitEl.textContent = "หน่วย"; qtyEl.disabled = false; qtyEl.placeholder = "จำนวน";
      hint.textContent = ""; hint.className = "med-hint"; updateAddBtn(); return;
    }
    if (idx === "none") {   // ไม่จ่ายยา → ล็อกหน่วย/จำนวนทันที
      unitEl.textContent = "-"; qtyEl.value = ""; qtyEl.disabled = true; qtyEl.placeholder = "—";
      hint.className = "med-hint ok"; hint.textContent = "ไม่จ่ายยา (ไม่ต้องกรอกจำนวน)"; updateAddBtn(); return;
    }
    var med = DB.medicines[+idx];
    unitEl.textContent = med.unit; qtyEl.disabled = false; qtyEl.placeholder = "จำนวน";
    var bs = baseSymptom();
    if (bs && !isOther(bs) && (med.symptoms || []).indexOf(bs) < 0 && (med.symptoms || []).length) {
      hint.className = "med-hint warn";
      hint.innerHTML = "⚠ ยานี้อาจไม่ตรงกับอาการ “" + esc(bs) + "” — ใช้สำหรับ: " + esc(med.treats);
    } else {
      hint.className = "med-hint ok";
      hint.innerHTML = med.treats ? "ใช้สำหรับ: " + esc(med.treats) : "";
    }
    updateAddBtn();
  }
  function refreshMedHints() {
    var lines = $("med-list").querySelectorAll(".med-line");
    for (var i = 0; i < lines.length; i++) updateMedLine(lines[i]);
  }
  /* ถ้ามีแถวใดเลือก "ไม่จ่ายยา" → ล็อกปุ่มเพิ่มรายการยา */
  function updateAddBtn() {
    var sels = $("med-list").querySelectorAll(".med-name"), hasNone = false;
    for (var i = 0; i < sels.length; i++) if (sels[i].value === "none") { hasNone = true; break; }
    var btn = $("btn-add-med");
    btn.disabled = hasNone;
    btn.classList.toggle("disabled", hasNone);
    btn.title = hasNone ? "ยกเลิก “ไม่จ่ายยา” ก่อนจึงจะเพิ่มรายการได้" : "";
  }
  function collectMeds() {
    var lines = $("med-list").querySelectorAll(".med-line"), meds = [];
    for (var i = 0; i < lines.length; i++) {
      var idx = lines[i].querySelector(".med-name").value; if (idx === "") continue;
      if (idx === "none") { meds.push({ name: "ไม่จ่ายยา", unit: "-", qty: "-", none: true, symptoms: [] }); continue; }
      var med = DB.medicines[+idx], qty = lines[i].querySelector(".med-qty").value.trim();
      meds.push({ name: med.name, unit: med.unit, qty: qty, treats: med.treats, symptoms: med.symptoms || [], none: false });
    }
    return meds;
  }

  /* ---------- โค้ด 6 หลักสุ่ม (ออฟไลน์) ---------- */
  function genCode() {
    var recs = loadRecords(), used = {};
    for (var i = 0; i < recs.length; i++) used[recs[i].code] = true;
    var code;
    do { code = "" + Math.floor(100000 + Math.random() * 900000); } while (used[code]);
    return { code: code };
  }

  /* ---------- Submit ---------- */
  function submitRecord(e) {
    e.preventDefault();
    if (submitting) return;
    if (!currentEmp) {
      if (empMode === "contractor") toast("กรุณากรอกและกด “ยืนยัน” ข้อมูลผู้รับเหมาก่อน");
      else { toast("กรุณาเลือกพนักงานก่อน"); $("emp-search").focus(); }
      return;
    }
    var emp = currentEmp;
    var bs = baseSymptom();
    if (!bs) { toast("กรุณาเลือกอาการป่วย"); $("symptom").focus(); return; }
    if (isOther(bs) && !$("symptom-other").value.trim()) { toast("กรุณาระบุอาการ (ช่องโปรดระบุ)"); $("symptom-other").focus(); return; }

    var meds = collectMeds();
    if (meds.length === 0) { toast("กรุณาเลือกยาที่เบิก หรือเลือก “ไม่จ่ายยา”"); return; }
    var noQty = meds.filter(function (m) { return !m.none && !m.qty; });
    if (noQty.length) { toast("กรุณากรอกจำนวนยาให้ครบทุกรายการ"); return; }

    var rec = {
      datetime: new Date().toISOString(),
      nurseCode: currentNurse.code, nurseName: currentNurse.name,
      empId: emp.id,
      empName: (emp.firstName || "") + " " + (emp.lastName || ""),
      prefix: emp.prefix, engName: emp.engName,
      age: emp.age, gender: emp.gender,
      position: emp.position, sector: emp.sector,
      division: emp.division, department: emp.department, group: emp.group,
      symptom: resolvedSymptom(),
      meds: meds.map(function (m) { return { name: m.name, unit: m.unit, qty: m.qty }; }),
      note: $("note").value.trim()
    };

    var bad = (bs && !isOther(bs))
      ? meds.filter(function (m) { return (m.symptoms || []).length && m.symptoms.indexOf(bs) < 0; })
      : [];
    if (bad.length) {
      showWarnModal(bs, bad, function (ok) { if (ok) doSave(rec); });
      return;
    }
    doSave(rec);
  }

  function doSave(rec) {
    if (submitting) return;
    submitting = true;
    var btn = document.querySelector(".btn-submit"); if (btn) { btn.disabled = true; btn.style.opacity = ".6"; }
    storeAddRecord(rec).then(function (res) {
      if (!rec.datetime) rec.datetime = new Date().toISOString();
      lastSlip = { rec: rec, code: res.code };
      showCodeModal(res); refreshLog();
    }).catch(function (err) {
      toast("บันทึกไม่สำเร็จ: " + err.message);
    }).then(function () {
      submitting = false; if (btn) { btn.disabled = false; btn.style.opacity = ""; }
    });
  }

  /* popup เตือน: ยาไม่ตรงกับอาการ */
  var warnCb = null;
  function showWarnModal(symptom, bad, cb) {
    warnCb = cb;
    $("warn-text").innerHTML = 'ยาที่เบิกอาจไม่ตรงกับอาการ “<b>' + esc(symptom) + '</b>” ต้องการบันทึกต่อหรือไม่?';
    $("warn-list").innerHTML = bad.map(function (m) {
      return '<div class="warn-item"><b>' + esc(m.name) + '</b><span>ใช้สำหรับ: ' + esc(m.treats || "-") + '</span></div>';
    }).join("");
    show($("warn-modal"));
  }
  function closeWarn(ok) {
    hide($("warn-modal"));
    var cb = warnCb; warnCb = null;
    if (cb) cb(ok);
  }

  function showCodeModal(g) {
    var out = $("code-out");
    out.textContent = g.code;
    out.dataset.code = g.code;
    var p = $("code-modal").querySelector("p");
    if (p) p.textContent = g.offline ? "⚠ บันทึกออฟไลน์ — จะซิงค์เข้าระบบเมื่อออนไลน์ (นำโค้ดไปลง Log Book ได้เลย)" : "กรุณานำโค้ดนี้ไปบันทึกใน Log Book";
    show($("code-modal"));
  }
  function closeModal() { hide($("code-modal")); resetForm(); $("emp-search").focus(); }
  function copyCode() {
    var code = $("code-out").dataset.code || "";
    if (navigator.clipboard && navigator.clipboard.writeText)
      navigator.clipboard.writeText(code).then(function () { toast("คัดลอกโค้ด " + code + " แล้ว"); }, function () { toast("โค้ด: " + code); });
    else toast("โค้ด: " + code);
  }
  function resetForm() {
    currentEmp = null;
    $("emp-search").value = ""; $("emp-error").textContent = ""; hide($("emp-box"));
    hide($("history-card"));
    $("c-first").value = ""; $("c-last").value = ""; $("c-age").value = ""; $("c-company").value = "";
    setEmpMode("emp");
    $("symptom").value = ""; hide($("symptom-other")); $("symptom-other").value = "";
    $("note").value = "";
    $("med-list").innerHTML = ""; addMedLine();
    if (currentNurse) $("nurse-locked").value = currentNurse.name;
  }

  /* ---------- ประวัติ / log ---------- */
  function fmtDate(iso) {
    if (!iso) return "-";
    var d = new Date(iso); if (isNaN(d.getTime())) return "-";
    var pad = function (n) { return String(n).padStart(2, "0"); };
    return pad(d.getDate()) + "/" + pad(d.getMonth() + 1) + "/" + (d.getFullYear() + 543) +
      " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function medsToText(r) {
    if (r.medsText) return r.medsText;
    return (r.meds || []).map(function (m) { return m.name + " (" + m.qty + " " + m.unit + ")"; }).join(", ") || "-";
  }
  /* แยกชื่อยา กับ จำนวน ออกจากกัน */
  function medsParts(r) {
    var arr = recMeds(r);
    return {
      names: arr.map(function (m) { return m.name; }).join(", ") || "-",
      qtys: arr.map(function (m) { return ((m.qty || "-") + (m.unit ? " " + m.unit : "")).trim(); }).join(", ") || "-"
    };
  }
  function refreshLog() {
    return storeListRecords().then(function (list) {
      lastRecords = list; renderLogList($("log-search") ? $("log-search").value : "");
    }).catch(function (e) { toast("โหลดประวัติไม่สำเร็จ: " + e.message); });
  }
  function renderLogList(filter) {
    var recs = lastRecords.slice().reverse();
    var q = (filter || "").trim().toLowerCase();
    if (q) recs = recs.filter(function (r) {
      return ((r.code || "") + " " + (r.empId || "") + " " + (r.empName || "") + " " + (r.nurseName || "")).toLowerCase().indexOf(q) >= 0;
    });
    var body = $("log-body"); body.innerHTML = "";
    if (recs.length === 0) show($("log-empty")); else hide($("log-empty"));
    recs.forEach(function (r) {
      var tr = document.createElement("tr");
      tr.innerHTML =
        '<td class="code-cell">' + esc(r.code) + "</td>" +
        "<td>" + esc(fmtDate(r.datetime)) + "</td>" +
        "<td>" + esc(r.empId) + "</td>" +
        "<td>" + esc(r.empName) + "</td>" +
        "<td>" + esc(r.symptom) + "</td>" +
        "<td>" + esc(medsToText(r)) + "</td>" +
        "<td>" + esc(r.nurseName) + "</td>";
      body.appendChild(tr);
    });
  }
  /* พิมพ์ผ่านหน้าต่างใหม่ (#8 สลิป, #11 รายงาน) */
  function printHTML(title, bodyHtml) {
    var w = window.open("", "_blank", "width=520,height=680");
    if (!w) { toast("เบราว์เซอร์บล็อกป๊อปอัป — อนุญาตก่อนพิมพ์"); return; }
    w.document.write('<html><head><meta charset="utf-8"><title>' + title + '</title><style>' +
      'body{font-family:"Sarabun","Segoe UI",sans-serif;padding:20px;color:#0d3b46}' +
      'h1{color:#0b6e86;font-size:20px;margin:0 0 2px}h2{color:#0b6e86;font-size:15px;margin:16px 0 6px;border-bottom:2px solid #d5eef2;padding-bottom:3px}' +
      '.muted{color:#4a6b73;font-size:13px}.code{font-size:32px;font-weight:800;letter-spacing:6px;text-align:center;border:2px dashed #2bc4d6;border-radius:12px;padding:12px;margin:12px 0;color:#0b6e86}' +
      'table{width:100%;border-collapse:collapse;font-size:13.5px;margin-top:4px}td,th{padding:5px 6px;text-align:left;border-bottom:1px solid #e6f2f5}th{color:#0b6e86}td.l{color:#4a6b73;width:36%}' +
      '.tot{font-weight:800;color:#0b6e86}@media print{.noprint{display:none}}' +
      '</style></head><body>' + bodyHtml +
      '<div class="noprint" style="margin-top:18px;text-align:center"><button onclick="window.print()" style="padding:10px 24px;border:0;border-radius:8px;background:#0b6e86;color:#fff;font-size:15px;cursor:pointer">🖨 พิมพ์</button></div>' +
      '</body></html>');
    w.document.close();
    setTimeout(function () { try { w.print(); } catch (e) {} }, 400);
  }
  var lastSlip = null;
  function printSlip() {
    if (!lastSlip) { toast("ไม่มีข้อมูลสลิป"); return; }
    var r = lastSlip.rec, mp = medsParts(r);
    var html = '<h1>MLCare — สลิปการใช้บริการห้องพยาบาล</h1>' +
      '<div class="code">' + esc(lastSlip.code) + '</div>' +
      '<table>' +
      '<tr><td class="l">วันที่-เวลา</td><td>' + esc(fmtDate(r.datetime)) + '</td></tr>' +
      '<tr><td class="l">รหัสพนักงาน</td><td>' + esc(r.empId) + '</td></tr>' +
      '<tr><td class="l">ชื่อ-สกุล</td><td>' + esc(r.empName) + '</td></tr>' +
      '<tr><td class="l">แผนก</td><td>' + esc(r.department || "-") + '</td></tr>' +
      '<tr><td class="l">อาการ</td><td>' + esc(r.symptom) + '</td></tr>' +
      '<tr><td class="l">ยาที่เบิก</td><td>' + esc(mp.names) + '</td></tr>' +
      '<tr><td class="l">จำนวน</td><td>' + esc(mp.qtys) + '</td></tr>' +
      '<tr><td class="l">หมายเหตุ</td><td>' + esc(r.note || "-") + '</td></tr>' +
      '<tr><td class="l">พยาบาลผู้ให้บริการ</td><td>' + esc(r.nurseName) + '</td></tr>' +
      '</table>';
    printHTML("สลิป " + lastSlip.code, html);
  }
  function printReport() {
    var now = new Date();
    var recs = adminData.records.filter(function (r) { var x = new Date(r.datetime); return x.getFullYear() === now.getFullYear() && x.getMonth() === now.getMonth(); });
    var monthName = now.toLocaleDateString("th-TH", { month: "long" }) + " " + (now.getFullYear() + 543);
    function tbl(title, items) {
      if (!items.length) return '<h2>' + title + '</h2><div class="muted">— ไม่มีข้อมูล —</div>';
      return '<h2>' + title + '</h2><table>' + items.map(function (i, k) { return '<tr><td>' + (k + 1) + '. ' + esc(i.label) + '</td><td style="text-align:right" class="tot">' + i.value + '</td></tr>'; }).join('') + '</table>';
    }
    var uniq = {}; recs.forEach(function (r) { if (r.empId) uniq[r.empId] = 1; });
    var medCount = {}; recs.forEach(function (r) { recMeds(r).forEach(function (m) { if (m.name && !/ไม่จ่าย/.test(m.name)) medCount[m.name] = (medCount[m.name] || 0) + 1; }); });
    var html = '<h1>รายงานการให้บริการห้องพยาบาล</h1><div class="muted">ประจำเดือน ' + monthName + ' • พิมพ์เมื่อ ' + fmtDate(now.toISOString()) + '</div>' +
      '<h2>สรุป</h2><table>' +
      '<tr><td>จำนวนการให้บริการ</td><td style="text-align:right" class="tot">' + recs.length + ' ครั้ง</td></tr>' +
      '<tr><td>พนักงานที่ใช้บริการ</td><td style="text-align:right" class="tot">' + Object.keys(uniq).length + ' คน</td></tr>' +
      '</table>' +
      tbl("อาการที่พบบ่อย (Top 10)", toItems(grpCount(recs, function (r) { return (r.symptom || "").split(":")[0].trim(); })).slice(0, 10)) +
      tbl("ยาที่จ่ายบ่อย (Top 10)", toItems(medCount).slice(0, 10)) +
      tbl("แผนกที่ใช้บริการ (Top 10)", toItems(grpCount(recs, function (r) { return r.department; })).slice(0, 10));
    printHTML("รายงาน " + monthName, html);
  }

  function downloadCSV(filename, headers, rows) {
    var csv = [headers].concat(rows).map(function (row) {
      return row.map(function (c) { return '"' + String(c == null ? "" : c).replace(/"/g, '""') + '"'; }).join(",");
    }).join("\r\n");
    var blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  }
  function exportCSV(recsArg) {
    var recs = recsArg && recsArg.length ? recsArg : lastRecords;
    if (!recs.length) { toast("ยังไม่มีข้อมูลให้ส่งออก"); return; }
    var headers = ["โค้ด", "วันที่เวลา", "รหัสพนักงาน", "ชื่อ-สกุล", "อายุ", "เพศ",
      "ตำแหน่ง", "ด้าน", "ฝ่าย", "แผนก", "กลุ่ม", "อาการ", "ยาที่เบิก", "หมายเหตุ", "พยาบาล"];
    var rows = recs.map(function (r) {
      return [r.code, fmtDate(r.datetime), r.empId, r.empName, r.age, r.gender,
        r.position, r.sector, r.division, r.department, r.group, r.symptom, medsToText(r), r.note, r.nurseName];
    });
    var csv = [headers].concat(rows).map(function (row) {
      return row.map(function (c) { return '"' + String(c == null ? "" : c).replace(/"/g, '""') + '"'; }).join(",");
    }).join("\r\n");
    var blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = "mlcare_records.csv";
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  }

  /* ============================================================
     ADMIN
     ============================================================ */
  var adminData = { records: [], stock: [], movements: [], loaded: false };
  function isAdminRole(role) { return /admin/i.test(role || ""); }

  function adminLoad(force) {
    if (adminData.loaded && !force) { renderCurrentAdmin(); return; }
    var recP = storeListRecords();
    var stkP = USE_API ? apiGet("stock").then(function (r) { return (r && r.stock) || []; }) : Promise.resolve([]);
    var movP = USE_API ? apiGet("movements").then(function (r) { return (r && r.movements) || []; }) : Promise.resolve([]);
    Promise.all([recP, stkP, movP]).then(function (res) {
      adminData.records = res[0] || []; adminData.stock = res[1] || []; adminData.movements = res[2] || [];
      adminData.loaded = true; renderCurrentAdmin();
    }).catch(function (e) { toast("โหลดข้อมูลแอดมินไม่สำเร็จ: " + e.message); });
  }
  function renderCurrentAdmin() {
    var a = document.querySelector(".tab.active"), name = a ? a.dataset.tab : "dashboard";
    if (name === "dashboard") renderDashboard();
    else if (name === "ahistory") renderAdminHistory($("ah-search") ? $("ah-search").value : "");
    else if (name === "analytics") renderAnalytics();
    else if (name === "stock") renderStock();
  }
  /* aggregation & charts */
  function grpCount(arr, keyFn) { var m = {}; arr.forEach(function (x) { var k = keyFn(x); if (k == null || k === "") k = "(ไม่ระบุ)"; m[k] = (m[k] || 0) + 1; }); return m; }
  function toItems(mapObj) { return Object.keys(mapObj).map(function (k) { return { label: k, value: mapObj[k] }; }).sort(function (a, b) { return b.value - a.value; }); }
  function barChart(items, limit) {
    var arr = limit ? items.slice(0, limit) : items;
    if (!arr.length) return '<div class="empty">— ไม่มีข้อมูล —</div>';
    var max = Math.max.apply(null, arr.map(function (i) { return i.value; }).concat([1]));
    return '<div class="bars">' + arr.map(function (i) {
      var w = Math.round(i.value / max * 100);
      return '<div class="bar-row"><span class="bar-label" title="' + esc(i.label) + '">' + esc(i.label) + '</span>' +
        '<span class="bar-track"><span class="bar-fill" style="width:' + w + '%"></span></span>' +
        '<span class="bar-val">' + i.value + '</span></div>';
    }).join('') + '</div>';
  }
  function recMeds(r) {
    if (r.meds && r.meds.length) return r.meds;
    if (!r.medsText) return [];
    return r.medsText.split("|").map(function (s) {
      s = s.trim(); var mm = s.match(/^(.*?) x(\S+)\s*(.*)$/);
      if (mm) return { name: mm[1].trim(), qty: mm[2], unit: mm[3] };
      return { name: s, qty: "", unit: "" };
    });
  }
  function sameDay(iso, d) { var x = new Date(iso); return x.getFullYear() === d.getFullYear() && x.getMonth() === d.getMonth() && x.getDate() === d.getDate(); }
  function ageBucket(age) {
    var a = parseInt(age, 10);
    if (isNaN(a) || a <= 0) return "ไม่ระบุ";
    if (a < 20) return "ต่ำกว่า 20";
    if (a < 30) return "20–29";
    if (a < 40) return "30–39";
    if (a < 50) return "40–49";
    if (a < 60) return "50–59";
    return "60 ขึ้นไป";
  }

  function renderDashboard() {
    var recs = adminData.records, now = new Date();
    if ($("dash-name")) $("dash-name").textContent = currentNurse ? currentNurse.name : "Admin";
    if ($("dash-updated")) $("dash-updated").textContent = fmtDate(now.toISOString()) + " น.";
    var today = recs.filter(function (r) { return r.datetime && sameDay(r.datetime, now); }).length;
    var month = recs.filter(function (r) { var x = new Date(r.datetime); return x.getFullYear() === now.getFullYear() && x.getMonth() === now.getMonth(); }).length;
    var uniq = {}; recs.forEach(function (r) { if (r.empId) uniq[r.empId] = 1; });
    var low = adminData.stock.filter(function (s) { return s.qty <= 5; }).length;
    var kpis = [
      { label: "บันทึกทั้งหมด", unit: "รายการ", value: recs.length, ic: "📋", c: "teal" },
      { label: "วันนี้", unit: "รายการ", value: today, ic: "📅", c: "blue" },
      { label: "เดือนนี้", unit: "รายการ", value: month, ic: "🗓️", c: "green" },
      { label: "พนักงานที่ใช้บริการ", unit: "คน", value: Object.keys(uniq).length, ic: "👥", c: "purple" },
      { label: "ยาใกล้หมด (≤5)", unit: "รายการ", value: low, ic: "⚠️", c: "amber" }
    ];
    $("kpi-row").innerHTML = kpis.map(function (k) {
      return '<div class="kpi kpi-' + k.c + '"><div class="kpi-ic">' + k.ic + '</div><div class="kpi-body"><b>' + k.value + '</b><small>' + esc(k.label) + '</small><span class="kpi-unit">' + esc(k.unit) + '</span></div></div>';
    }).join('');
    // #12 เตือน cluster อาการ (อาการเดียวพุ่ง ≥3 ครั้งวันนี้)
    var todayRecs = recs.filter(function (r) { return r.datetime && sameDay(r.datetime, now); });
    var todaySymp = toItems(grpCount(todayRecs, function (r) { return (r.symptom || "").split(":")[0].trim(); }));
    var clusters = todaySymp.filter(function (s) { return s.value >= 3 && !isOther(s.label) && s.label; });
    $("cluster-alert").innerHTML = clusters.length
      ? '<div class="cluster-box"><span class="cluster-ic">⚠️</span><div><b>พบอาการผิดปกติวันนี้</b><div class="cluster-list">' +
        clusters.map(function (c) { return esc(c.label) + " <b>" + c.value + " คน</b>"; }).join(" · ") +
        '</div><small>อาจเป็นสัญญาณการระบาด/อาหารเป็นพิษ — ควรตรวจสอบ</small></div></div>'
      : "";
    $("dash-symptoms").innerHTML = barChart(toItems(grpCount(recs, function (r) { return r.symptom; })), 6);
    var medCount = {}; recs.forEach(function (r) { recMeds(r).forEach(function (m) { if (m.name && m.name !== "ไม่จ่ายยา") medCount[m.name] = (medCount[m.name] || 0) + 1; }); });
    $("dash-meds").innerHTML = barChart(toItems(medCount), 6);
    $("dash-depts").innerHTML = barChart(toItems(grpCount(recs, function (r) { return r.department; })), 6);
  }
  function renderAdminHistory(filter) {
    var recs = adminData.records.slice().reverse();
    var q = (filter || "").trim().toLowerCase();
    if (q) recs = recs.filter(function (r) {
      return ((r.code || "") + " " + (r.empId || "") + " " + (r.empName || "") + " " + (r.department || "") + " " + (r.symptom || "") + " " + (r.nurseName || "")).toLowerCase().indexOf(q) >= 0;
    });
    var from = $("ah-from") && $("ah-from").value ? new Date($("ah-from").value + "T00:00:00") : null;
    var to = $("ah-to") && $("ah-to").value ? new Date($("ah-to").value + "T23:59:59") : null;
    if (from || to) recs = recs.filter(function (r) {
      var d = new Date(r.datetime); if (isNaN(d.getTime())) return false;
      if (from && d < from) return false; if (to && d > to) return false; return true;
    });
    var body = $("ah-body");
    if (!recs.length) { body.innerHTML = ""; show($("ah-empty")); return; }
    hide($("ah-empty"));
    body.innerHTML = recs.map(function (r) {
      var mp = medsParts(r);
      var edited = r.status ? " <span class='edited-tag' title='" + esc(r.status) + "'>✎</span>" : "";
      return "<tr><td class='code-cell'>" + esc(r.code) + edited + "</td><td>" + esc(fmtDate(r.datetime)) + "</td><td>" + esc(r.empId) +
        "</td><td>" + esc(r.empName) + "</td><td>" + esc(r.gender) + "</td><td>" + esc(r.age) + "</td><td>" + esc(r.department) +
        "</td><td>" + esc(r.symptom) + "</td><td>" + esc(mp.names) + "</td><td>" + esc(mp.qtys) + "</td><td>" + esc(r.nurseName) +
        "</td><td class='row-actions'><button class='btn-edit-row' data-code='" + esc(r.code) + "' title='แก้ไข'>✎</button>" +
        "<button class='btn-del-row' data-code='" + esc(r.code) + "' title='ลบรายการนี้'>🗑</button></td></tr>";
    }).join('');
  }
  var AN_COLORS = ['#12a0b8', '#e88f1c', '#8a5cd0', '#1f9d74', '#d64545', '#3f74d0', '#c05fa0'];
  /* กราฟเส้น + พื้นที่ (SVG) */
  function svgLine(data) {
    if (!data.length) return '<div class="empty">— ไม่มีข้อมูล —</div>';
    var W = 660, H = 200, pl = 30, pr = 14, pt = 16, pb = 26, n = data.length;
    var max = Math.max.apply(null, data.map(function (d) { return d.value; }).concat([1]));
    var X = function (i) { return pl + (n <= 1 ? (W - pl - pr) / 2 : i * (W - pl - pr) / (n - 1)); };
    var Y = function (v) { return pt + (H - pt - pb) * (1 - v / max); };
    var pts = data.map(function (d, i) { return [X(i), Y(d.value)]; });
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
    var area = line + ' L' + X(n - 1).toFixed(1) + ' ' + (H - pb) + ' L' + X(0).toFixed(1) + ' ' + (H - pb) + ' Z';
    var step = Math.max(1, Math.ceil(n / 8));
    var dots = '', labels = '';
    pts.forEach(function (p, i) {
      dots += '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="3.2" fill="#0b6e86"><title>' + esc(data[i].label) + ': ' + data[i].value + '</title></circle>';
      if (i % step === 0 || i === n - 1) labels += '<text x="' + p[0].toFixed(1) + '" y="' + (H - 8) + '" font-size="10" text-anchor="middle" fill="#4a6b73">' + esc(data[i].label) + '</text>';
    });
    var gy = pt + (H - pt - pb) * 0.5;
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="an-svg" style="width:100%;height:auto;display:block">' +
      '<defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2bc4d6" stop-opacity="0.35"/><stop offset="1" stop-color="#2bc4d6" stop-opacity="0.02"/></linearGradient></defs>' +
      '<line x1="' + pl + '" y1="' + gy.toFixed(1) + '" x2="' + (W - pr) + '" y2="' + gy.toFixed(1) + '" stroke="#e6f2f5" stroke-width="1"/>' +
      '<line x1="' + pl + '" y1="' + (H - pb) + '" x2="' + (W - pr) + '" y2="' + (H - pb) + '" stroke="#d5eef2" stroke-width="1"/>' +
      '<text x="' + (pl - 6) + '" y="' + (pt + 4) + '" font-size="10" text-anchor="end" fill="#4a6b73">' + max + '</text>' +
      '<path d="' + area + '" fill="url(#ag)"/>' +
      '<path d="' + line + '" fill="none" stroke="#12a0b8" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>' +
      dots + labels + '</svg>';
  }
  /* โดนัท (SVG) */
  function donut(items) {
    items = items.filter(function (i) { return i.value > 0; });
    var total = items.reduce(function (a, i) { return a + i.value; }, 0);
    if (!total) return '<div class="empty">— ไม่มีข้อมูล —</div>';
    var R = 54, C = 2 * Math.PI * R, off = 0, segs = '', legend = '';
    items.forEach(function (it, idx) {
      var len = it.value / total * C, col = AN_COLORS[idx % AN_COLORS.length];
      segs += '<circle cx="70" cy="70" r="' + R + '" fill="none" stroke="' + col + '" stroke-width="20" stroke-dasharray="' + len.toFixed(2) + ' ' + (C - len).toFixed(2) + '" stroke-dashoffset="' + (-off).toFixed(2) + '" transform="rotate(-90 70 70)"/>';
      off += len;
      legend += '<div class="lg-item"><span class="lg-dot" style="background:' + col + '"></span>' + esc(it.label) + ' <b>' + it.value + '</b> <span class="lg-pct">' + Math.round(it.value / total * 100) + '%</span></div>';
    });
    return '<div class="donut-wrap"><svg viewBox="0 0 140 140" style="width:132px;height:132px;flex:0 0 auto">' + segs +
      '<text x="70" y="66" text-anchor="middle" font-size="12" fill="#4a6b73">รวม</text>' +
      '<text x="70" y="86" text-anchor="middle" font-size="20" font-weight="800" fill="#0d3b46">' + total + '</text></svg>' +
      '<div class="donut-legend">' + legend + '</div></div>';
  }
  /* อันดับ (มีเลข + เหรียญ Top 3) */
  function rankBars(items, limit) {
    var arr = limit ? items.slice(0, limit) : items;
    if (!arr.length) return '<div class="empty">— ไม่มีข้อมูล —</div>';
    var max = Math.max.apply(null, arr.map(function (i) { return i.value; }).concat([1]));
    return '<div class="rbars">' + arr.map(function (i, idx) {
      var w = Math.round(i.value / max * 100), medal = idx === 0 ? 'm1' : idx === 1 ? 'm2' : idx === 2 ? 'm3' : '';
      return '<div class="rbar"><span class="rk ' + medal + '">' + (idx + 1) + '</span>' +
        '<span class="rbar-label" title="' + esc(i.label) + '">' + esc(i.label) + '</span>' +
        '<span class="rbar-track"><span class="rbar-fill" style="width:' + w + '%"></span></span>' +
        '<span class="rbar-val">' + i.value + '</span></div>';
    }).join('') + '</div>';
  }

  function renderAnalytics() {
    var recs = adminData.records, now = new Date();
    var period = parseInt(($("an-period") && $("an-period").value) || "14", 10);
    var days = [];
    for (var i = period - 1; i >= 0; i--) days.push(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i));
    var daily = days.map(function (d) {
      var c = recs.filter(function (r) { return r.datetime && sameDay(r.datetime, d); }).length;
      return { label: (d.getMonth() + 1) + "/" + d.getDate(), value: c };
    });
    var periodTotal = daily.reduce(function (a, x) { return a + x.value; }, 0);
    var busiest = daily.reduce(function (m, x) { return x.value > m.value ? x : m; }, { value: -1, label: "-" });
    var uniq = {}; recs.forEach(function (r) { if (r.empId) uniq[r.empId] = 1; });
    var sympItems = toItems(grpCount(recs, function (r) { return r.symptom; }));
    var topSymp = sympItems.length ? sympItems[0].label : "-";

    if ($("an-sub")) $("an-sub").textContent = "ช่วง " + period + " วันล่าสุด • " + periodTotal + " ครั้ง";
    var kpis = [
      { ic: "📋", c: "teal", value: periodTotal, label: "บริการในช่วงนี้", unit: "ครั้ง" },
      { ic: "📈", c: "blue", value: (periodTotal / period).toFixed(1), label: "เฉลี่ยต่อวัน", unit: "ครั้ง/วัน" },
      { ic: "🔥", c: "amber", value: busiest.value < 0 ? 0 : busiest.value, label: "วันที่มากสุด (" + busiest.label + ")", unit: "ครั้ง" },
      { ic: "👥", c: "purple", value: Object.keys(uniq).length, label: "พนักงานทั้งหมด", unit: "คน" },
      { ic: "🤒", c: "green", value: topSymp, label: "อาการอันดับ 1", unit: "" }
    ];
    $("an-kpi").innerHTML = kpis.map(function (k) {
      var big = String(k.value).length > 6 ? "font-size:17px" : "";
      return '<div class="kpi kpi-' + k.c + '"><div class="kpi-ic">' + k.ic + '</div><div class="kpi-body"><b style="' + big + '">' + esc(k.value) + '</b><small>' + esc(k.label) + '</small><span class="kpi-unit">' + esc(k.unit) + '</span></div></div>';
    }).join('');

    $("an-trend").innerHTML = svgLine(daily);
    $("an-gender").innerHTML = rankBars(toItems(grpCount(recs, function (r) { return r.gender; })), 5);
    $("an-symptom").innerHTML = rankBars(sympItems, 8);
    $("an-emp").innerHTML = rankBars(toItems(grpCount(recs, function (r) { return (r.empName || r.empId || "").trim(); })), 8);
    var medCount = {}; recs.forEach(function (r) { recMeds(r).forEach(function (m) { if (m.name && !/ไม่จ่าย/.test(m.name)) medCount[m.name] = (medCount[m.name] || 0) + 1; }); });
    $("an-meds").innerHTML = rankBars(toItems(medCount), 8);
    // ช่วงอายุที่มาใช้บริการ (เรียงตามช่วง ไม่เรียงตามจำนวน)
    var ageOrder = ["ต่ำกว่า 20", "20–29", "30–39", "40–49", "50–59", "60 ขึ้นไป", "ไม่ระบุ"];
    var ageCnt = {}; recs.forEach(function (r) { var b = ageBucket(r.age); ageCnt[b] = (ageCnt[b] || 0) + 1; });
    var ageItems = ageOrder.filter(function (k) { return ageCnt[k]; }).map(function (k) { return { label: k, value: ageCnt[k] }; });
    $("an-age").innerHTML = barChart(ageItems);
    $("an-nurse").innerHTML = rankBars(toItems(grpCount(recs, function (r) { return r.nurseName; })), 8);
  }
  function stockClass(q) { return q <= 5 ? "st-low" : (q <= 10 ? "st-mid" : "st-ok"); }
  function fmtDay(iso) {
    if (!iso) return "-";
    var d = new Date(iso); if (isNaN(d.getTime())) return "-";
    var p = function (n) { return String(n).padStart(2, "0"); };
    return p(d.getDate()) + "/" + p(d.getMonth() + 1) + "/" + (d.getFullYear() + 543);
  }
  function expiryInfo(iso) {
    if (!iso) return { has: false };
    var d = new Date(iso); if (isNaN(d.getTime())) return { has: false };
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var days = Math.floor((d - today) / 86400000);
    return { has: true, days: days, date: fmtDay(iso), cls: days < 0 ? "exp-out" : (days <= 60 ? "exp-warn" : "exp-ok") };
  }
  function renderStock() {
    if (!USE_API) {
      $("stock-body").innerHTML = '<tr><td colspan="4" class="empty">ระบบสต๊อกต้องเชื่อมฐานข้อมูล (ตั้ง API_URL)</td></tr>';
      $("stock-kpi").innerHTML = ""; $("stock-moves").innerHTML = ""; return;
    }
    // รวมแคตตาล็อกยา + ล็อตจากชีต (แสดงยาทุกตัว, per-row รับเข้าล็อตใหม่)
    var noD = function (n) { return !/ไม่จ่าย|ไม่ได้จ่าย/.test(n); };
    var smap = {}; adminData.stock.forEach(function (s) { if (noD(s.name)) smap[s.name] = s; });
    var meds = DB.medicines.filter(function (m) { return noD(m.name); }).map(function (m) {
      var s = smap[m.name]; return { name: m.name, unit: m.unit, qty: s ? s.qty : 0, lots: s ? (s.lots || []) : [] };
    });
    adminData.stock.forEach(function (s) {
      if (noD(s.name) && !DB.medicines.some(function (m) { return m.name === s.name; })) meds.push({ name: s.name, unit: s.unit, qty: s.qty, lots: s.lots || [] });
    });

    var low = meds.filter(function (m) { return m.qty <= 5; }).sort(function (a, b) { return a.qty - b.qty; });
    // เตือนหมดอายุ: ไล่ทุกล็อตของทุกยา
    var lotAlerts = [];
    meds.forEach(function (s) {
      (s.lots || []).forEach(function (l) { var e = expiryInfo(l.expiry); if (e.has && e.days <= 60) lotAlerts.push({ name: s.name, unit: s.unit, qty: l.qty, e: e }); });
    });
    lotAlerts.sort(function (a, b) { return a.e.days - b.e.days; });

    $("stock-kpi").innerHTML =
      '<div class="kpi kpi-teal"><div class="kpi-ic">📦</div><div class="kpi-body"><b>' + meds.length + '</b><small>รายการยาทั้งหมด</small></div></div>' +
      '<div class="kpi kpi-amber"><div class="kpi-ic">⚠️</div><div class="kpi-body"><b>' + low.length + '</b><small>ใกล้หมด/หมด (≤5)</small></div></div>' +
      '<div class="kpi kpi-red"><div class="kpi-ic">⏰</div><div class="kpi-body"><b>' + lotAlerts.length + '</b><small>ล็อตใกล้หมดอายุ/หมดอายุ</small></div></div>';

    $("stock-low").innerHTML = low.length
      ? '<div class="low-list">' + low.map(function (m) {
          var tag = m.qty === 0 ? "<span class='low-out'>หมด</span>" : "<span class='low-warn'>เหลือ " + m.qty + " " + esc(m.unit) + "</span>";
          return "<div class='low-item'><span>" + esc(m.name) + "</span>" + tag + "</div>";
        }).join('') + '</div>'
      : '<div class="empty">— ยาเพียงพอทุกรายการ —</div>';

    $("stock-exp").innerHTML = lotAlerts.length
      ? '<div class="low-list">' + lotAlerts.map(function (x) {
          var tag = x.e.days < 0 ? "<span class='low-out'>หมดอายุแล้ว</span>" : "<span class='low-warn'>อีก " + x.e.days + " วัน</span>";
          return "<div class='low-item'><span>" + esc(x.name) + " <small style='color:var(--ink-soft)'>(" + x.qty + " " + esc(x.unit) + " @ " + x.e.date + ")</small></span>" + tag + "</div>";
        }).join('') + '</div>'
      : '<div class="empty">— ไม่มีล็อตใกล้หมดอายุ —</div>';

    $("stock-body").innerHTML = meds.map(function (s) {
      var lotsCell = (s.lots && s.lots.length)
        ? s.lots.map(function (l) {
            var e = expiryInfo(l.expiry);
            var exp = e.has
              ? "<span class='exp-badge " + e.cls + "'>" + e.date + (e.days < 0 ? " · หมดอายุ" : e.days <= 60 ? " · อีก " + e.days + "ว" : "") + "</span>"
              : "<span class='exp-none'>ไม่มีวันหมดอายุ</span>";
            return "<div class='lot-row'><b>" + l.qty + "</b> " + esc(s.unit) + " " + exp + "</div>";
          }).join('')
        : "<span class='exp-none'>—</span>";
      return "<tr><td>" + esc(s.name) + "</td><td>" + esc(s.unit) + "</td>" +
        "<td><span class='stock-badge " + stockClass(s.qty) + "'>" + s.qty + "</span></td>" +
        "<td class='lots-cell'>" + lotsCell + "</td>" +
        "<td><div class='stock-add'><input type='number' min='1' class='inp stock-in' placeholder='จำนวน'>" +
        "<input type='date' class='inp stock-exp-in' title='วันหมดอายุ (ถ้ามี)'>" +
        "<button class='btn-add-stock' data-name='" + esc(s.name) + "' data-unit='" + esc(s.unit) + "'>+ รับเข้า</button></div></td></tr>";
    }).join('') || '<tr><td colspan="5" class="empty">ไม่มีรายการยา</td></tr>';
    var mv = adminData.movements;
    $("stock-moves").innerHTML = mv.length ? mv.slice(0, 60).map(function (m) {
      var cls = m.type === "รับเข้า" ? "mv-in" : "mv-out";
      return "<div class='mv-item " + cls + "'><span class='mv-time'>" + esc(fmtDate(m.time)) + "</span>" +
        "<span class='mv-name'>" + esc(m.name) + "</span><span class='mv-type'>" + esc(m.type) + "</span>" +
        "<span class='mv-qty'>" + (m.type === "รับเข้า" ? "+" : "−") + m.qty + "</span>" +
        "<span class='mv-bal'>คงเหลือ " + m.balance + "</span></div>";
    }).join('') : '<div class="empty">— ยังไม่มีความเคลื่อนไหว —</div>';
  }
  function addStockFromBtn(btn) {
    var name = btn.getAttribute("data-name"), unit = btn.getAttribute("data-unit");
    var input = btn.parentNode.querySelector(".stock-in");
    var expInput = btn.parentNode.querySelector(".stock-exp-in");
    var expiry = expInput ? expInput.value : "";
    var qty = parseInt(input.value, 10);
    if (isNaN(qty) || qty <= 0) { toast("กรุณากรอกจำนวนที่จะรับเข้า"); input.focus(); return; }
    btn.disabled = true;
    apiPost("addStock", { name: name, unit: unit, qty: qty, expiry: expiry, by: currentNurse ? currentNurse.name : "admin" }).then(function (res) {
      if (!res || !res.ok) throw new Error((res && res.error) || "เพิ่มไม่สำเร็จ");
      toast("✅ รับเข้าแล้ว: " + name + " +" + qty + " (คงเหลือ " + res.balance + ")");
      adminLoad(true);
    }).catch(function (e) { toast("เพิ่มสต๊อกไม่สำเร็จ: " + e.message); btn.disabled = false; });
  }
  function exportStockCSV() {
    var stock = adminData.stock.filter(function (s) { return !/ไม่จ่าย|ไม่ได้จ่าย/.test(s.name); });
    var rows = [];
    stock.forEach(function (s) { (s.lots || []).forEach(function (l) { rows.push([s.name, s.unit, l.qty, l.expiry ? fmtDay(l.expiry) : "", l.received ? fmtDate(l.received) : ""]); }); });
    if (!rows.length) { toast("ยังไม่มีข้อมูลสต๊อกให้ส่งออก"); return; }
    downloadCSV("mlcare_stock.csv", ["ชื่อยา", "หน่วย", "คงเหลือ(ล็อต)", "วันหมดอายุ", "รับเข้าเมื่อ"], rows);
  }

  /* ---------- PIN modal (ลบ/ล้างประวัติ) ---------- */
  var pinVerify = null;
  function showPin(title, text, verifyFn) {
    pinVerify = verifyFn;
    $("pin-title").textContent = title;
    $("pin-text").textContent = text || "กรอก PIN ผู้ดูแลระบบเพื่อดำเนินการ";
    $("pin-input").value = ""; $("pin-err").textContent = "";
    show($("pin-modal")); setTimeout(function () { $("pin-input").focus(); }, 50);
  }
  function closePin() { hide($("pin-modal")); pinVerify = null; }
  function submitPin() {
    var pin = $("pin-input").value.trim();
    if (!pin) { $("pin-err").textContent = "กรุณากรอก PIN"; return; }
    if (!pinVerify) return;
    var btn = $("pin-ok"); btn.disabled = true; $("pin-err").textContent = "กำลังตรวจสอบ…";
    pinVerify(pin).then(function () { btn.disabled = false; closePin(); })
      .catch(function (e) { btn.disabled = false; $("pin-err").textContent = e.message || "PIN ไม่ถูกต้อง"; $("pin-input").select(); });
  }
  function askDeleteRecord(code) {
    showPin("ลบรายการ " + code, "กรอก PIN ผู้ดูแลระบบเพื่อยืนยันการลบรายการนี้", function (pin) {
      return storeDeleteRecord(code, pin).then(function () { toast("ลบรายการ " + code + " แล้ว"); adminLoad(true); });
    });
  }
  /* แก้ไขรายการ (#5) */
  var editingCode = null;
  function openEdit(code) {
    var r = null, list = adminData.records;
    for (var i = 0; i < list.length; i++) if (list[i].code === code) { r = list[i]; break; }
    if (!r) return;
    editingCode = code;
    buildSymptomOptions($("edit-symptom"));
    var sel = $("edit-symptom"), other = $("edit-symptom-other"), sym = r.symptom || "";
    if (isOther(sym)) {
      var ov = "อื่น ๆ";
      for (var k = 0; k < sel.options.length; k++) if (isOther(sel.options[k].value)) { ov = sel.options[k].value; break; }
      sel.value = ov;
      other.value = sym.indexOf(":") >= 0 ? sym.slice(sym.indexOf(":") + 1).trim() : "";
      show(other);
    } else {
      var found = false;
      for (var j = 0; j < sel.options.length; j++) if (sel.options[j].value === sym) found = true;
      if (!found && sym) { var o = document.createElement("option"); o.value = sym; o.textContent = sym; sel.appendChild(o); }
      sel.value = sym; hide(other); other.value = "";
    }
    $("edit-note").value = r.note || "";
    $("edit-pin").value = ""; $("edit-err").textContent = "";
    $("edit-code").textContent = code;
    show($("edit-modal"));
  }
  function saveEdit() {
    var sel = $("edit-symptom"), sym = sel.value;
    if (!sym) { $("edit-err").textContent = "กรุณาเลือกอาการ"; return; }
    if (isOther(sym)) { var o = $("edit-symptom-other").value.trim(); if (!o) { $("edit-err").textContent = "กรุณาระบุอาการ"; return; } sym = sym + ": " + o; }
    var pin = $("edit-pin").value.trim(); if (!pin) { $("edit-err").textContent = "กรุณากรอก PIN"; return; }
    var btn = $("edit-ok"); btn.disabled = true; $("edit-err").textContent = "กำลังบันทึก…";
    storeUpdateRecord(editingCode, { symptom: sym, note: $("edit-note").value.trim(), pin: pin }).then(function () {
      btn.disabled = false; hide($("edit-modal")); toast("แก้ไขรายการ " + editingCode + " แล้ว"); adminLoad(true);
    }).catch(function (e) { btn.disabled = false; $("edit-err").textContent = e.message || "แก้ไขไม่สำเร็จ"; });
  }

  function askClearRecords() {
    if (!adminData.records.length) { toast("ยังไม่มีข้อมูลให้ล้าง"); return; }
    showPin("ล้างประวัติทั้งหมด", "⚠ ลบบันทึกทั้งหมดถาวร (" + adminData.records.length + " รายการ)! กรอก PIN เพื่อยืนยัน", function (pin) {
      return storeClearRecords(pin).then(function (res) { toast("ล้างประวัติแล้ว (" + (res.cleared != null ? res.cleared : "") + " รายการ)"); adminLoad(true); });
    });
  }

  /* ---------- จัดการบัญชีผู้ใช้ (แอดมิน) ---------- */
  var editingUserBadge = null;
  function roleLabel(r) { return /admin/i.test(r) ? "ผู้ดูแลระบบ" : "พยาบาล"; }
  function renderUsers() {
    var body = $("users-body");
    body.innerHTML = DB.nurses.map(function (u) {
      var isMe = currentNurse && u.badge === currentNurse.badge;
      var admin = /admin/i.test(u.role);
      return "<tr><td>" + esc(u.name) + (isMe ? " <span class='role-tag role-me'>คุณ</span>" : "") + "</td>" +
        "<td>" + esc(u.badge) + "</td><td>" + esc(u.pin) + "</td>" +
        "<td><span class='role-tag " + (admin ? "role-admin" : "role-nurse") + "'>" + esc(roleLabel(u.role)) + "</span></td>" +
        "<td class='row-actions'><button class='btn-edit-row u-edit' data-badge='" + esc(u.badge) + "' title='แก้ไข'>✎</button>" +
        (isMe ? "" : "<button class='btn-del-row u-del' data-badge='" + esc(u.badge) + "' title='ลบ'>🗑</button>") + "</td></tr>";
    }).join('') || "<tr><td colspan='5' class='empty'>ไม่มีบัญชี</td></tr>";
  }
  function reloadUsers() {
    if (!USE_API) { renderUsers(); return Promise.resolve(); }
    $("users-body").innerHTML = "<tr><td colspan='5' class='empty'>กำลังโหลดจากฐานข้อมูล…</td></tr>";
    return apiGet("bootstrap").then(function (res) {
      if (res && res.users && res.users.length) DB.nurses = res.users;
      renderUsers();
    }).catch(function (e) {
      $("users-body").innerHTML = "<tr><td colspan='5' class='empty'>โหลดไม่สำเร็จ: " + esc(e.message) + "</td></tr>";
    });
  }
  function apiUser(action, d) {
    if (!USE_API) return Promise.reject(new Error("ต้องเชื่อมฐานข้อมูลก่อน"));
    return apiPost(action, d).then(function (r) { if (!r || !r.ok) throw new Error((r && r.error) || "ไม่สำเร็จ"); return r; });
  }
  function openUserModal(mode, badge) {
    editingUserBadge = mode === "edit" ? badge : null;
    $("user-modal-title").textContent = mode === "edit" ? "แก้ไขบัญชี" : "เพิ่มบัญชี";
    $("u-err").textContent = "";
    if (mode === "edit") {
      var u = null; DB.nurses.forEach(function (x) { if (x.badge === badge) u = x; });
      if (!u) return;
      $("u-name").value = u.name; $("u-badge").value = u.badge; $("u-pin").value = "";
      $("u-role").value = /admin/i.test(u.role) ? "Adminstrator" : "recoder";
      $("u-pin-label").textContent = "PIN (เว้นว่าง = ไม่เปลี่ยน)";
    } else {
      $("u-name").value = ""; $("u-badge").value = ""; $("u-pin").value = ""; $("u-role").value = "recoder";
      $("u-pin-label").textContent = "PIN (อย่างน้อย 4 หลัก)";
    }
    show($("user-modal")); setTimeout(function () { $("u-name").focus(); }, 50);
  }
  function saveUser() {
    var name = $("u-name").value.trim(), badge = $("u-badge").value.trim(), pin = $("u-pin").value.trim(), role = $("u-role").value;
    if (!name || !badge) { $("u-err").textContent = "กรุณากรอกชื่อ และ Badge ID"; return; }
    var adminPin = currentNurse ? currentNurse.pin : "";
    var btn = $("u-save"); btn.disabled = true; $("u-err").textContent = "กำลังบันทึก…";
    var p;
    if (editingUserBadge) {
      p = apiUser("updateUser", { badge: editingUserBadge, name: name, newBadge: badge, pin: pin, role: role, adminPin: adminPin });
    } else {
      if (!/^\d{4,}$/.test(pin)) { btn.disabled = false; $("u-err").textContent = "PIN ต้องเป็นตัวเลขอย่างน้อย 4 หลัก"; return; }
      p = apiUser("addUser", { name: name, badge: badge, pin: pin, role: role, adminPin: adminPin });
    }
    p.then(function () { btn.disabled = false; hide($("user-modal")); toast(editingUserBadge ? "แก้ไขบัญชีแล้ว" : "เพิ่มบัญชีแล้ว"); reloadUsers(); })
      .catch(function (e) { btn.disabled = false; $("u-err").textContent = e.message || "บันทึกไม่สำเร็จ"; });
  }
  function askDeleteUser(badge) {
    if (currentNurse && badge === currentNurse.badge) { toast("ลบบัญชีของตัวเองไม่ได้"); return; }
    var u = null; DB.nurses.forEach(function (x) { if (x.badge === badge) u = x; });
    if (!window.confirm("ยืนยันลบบัญชี “" + (u ? u.name : badge) + "” ?")) return;
    apiUser("deleteUser", { badge: badge, adminPin: currentNurse ? currentNurse.pin : "" })
      .then(function () { toast("ลบบัญชีแล้ว"); reloadUsers(); })
      .catch(function (e) { toast("ลบไม่สำเร็จ: " + e.message); });
  }

  /* ---------- แท็บ ---------- */
  var PANELS = ["record", "log", "search-name", "search-dept", "dashboard", "ahistory", "analytics", "stock", "users"];
  var ADMIN_TABS = { dashboard: 1, ahistory: 1, analytics: 1, stock: 1 };
  function switchTab(name) {
    PANELS.forEach(function (p) { var el = $("tab-" + p); if (el) el.classList.toggle("hidden", p !== name); });
    var tabs = document.querySelectorAll(".tab[data-tab], .menu-item[data-tab]");
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle("active", tabs[i].dataset.tab === name);
    var more = $("btn-more"); if (more) more.classList.toggle("active", name.indexOf("search") === 0);
    hide($("more-menu"));
    if (name === "log") refreshLog();
    if (name === "search-dept") populateDepts();
    if (name === "users") reloadUsers();
    if (ADMIN_TABS[name]) adminLoad();
  }
  function toggleMore(e) { e.stopPropagation(); $("more-menu").classList.toggle("hidden"); }

  /* ---------- init ---------- */
  /* นาฬิกาวันที่/เวลาให้บริการ (ล็อก อัตโนมัติตามเวลาจริง) */
  function tickClock() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, "0"); };
    var sd = $("svc-date"), st = $("svc-time");
    if (sd) sd.value = p(d.getDate()) + "/" + p(d.getMonth() + 1) + "/" + (d.getFullYear() + 543);
    if (st) st.value = p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  function setConnBadge() {
    var f = document.querySelector(".app-footer");
    if (!f) return;
    var yr = new Date().getFullYear();
    var status = USE_API
      ? "<span style='color:#1f9d74'>● เชื่อมฐานข้อมูล Google Sheets</span>"
      : "<span style='color:#c07a2a'>● โหมดออฟไลน์ (localStorage)</span>";
    f.innerHTML = "© " + yr + " MLCare Medical Room System &nbsp;·&nbsp; " + status +
      "<div class='footer-org'>โรงงาน น้ำตาลมิตรลาว จำกัด</div>";
  }

  function init() {
    $("login-form").addEventListener("submit", doLogin);
    $("btn-logout").addEventListener("click", logout);
    $("btn-settings").addEventListener("click", openSettings);
    $("pinchg-cancel").addEventListener("click", function () { hide($("pinchg-modal")); });
    $("pinchg-ok").addEventListener("click", savePinChange);
    $("pinchg-new2").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); savePinChange(); } });
    $("pinchg-modal").addEventListener("click", function (e) { if (e.target === $("pinchg-modal")) hide($("pinchg-modal")); });
    $("btn-select-emp").addEventListener("click", selectEmployee);
    var emodeBtns = document.querySelectorAll(".emode-btn");
    for (var mi = 0; mi < emodeBtns.length; mi++) emodeBtns[mi].addEventListener("click", function () { setEmpMode(this.dataset.mode); });
    $("c-confirm").addEventListener("click", confirmContractor);
    $("c-clear").addEventListener("click", clearContractor);
    ["c-first", "c-last", "c-age", "c-company"].forEach(function (id) {
      $(id).addEventListener("input", function () { if (empMode === "contractor" && currentEmp) { currentEmp = null; hide($("contractor-box")); } });
    });
    $("emp-search").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); selectEmployee(); } });
    $("btn-add-med").addEventListener("click", function () { addMedLine(); });
    $("record-form").addEventListener("submit", submitRecord);
    $("btn-reset").addEventListener("click", resetForm);
    $("btn-ok").addEventListener("click", closeModal);
    $("btn-copy").addEventListener("click", copyCode);
    $("code-modal").addEventListener("click", function (e) { if (e.target === $("code-modal")) closeModal(); });
    $("warn-cancel").addEventListener("click", function () { closeWarn(false); });
    $("warn-proceed").addEventListener("click", function () { closeWarn(true); });
    $("warn-modal").addEventListener("click", function (e) { if (e.target === $("warn-modal")) closeWarn(false); });
    var tabs = document.querySelectorAll(".tab[data-tab], .menu-item[data-tab]");
    for (var i = 0; i < tabs.length; i++) tabs[i].addEventListener("click", function () { switchTab(this.dataset.tab); });
    document.addEventListener("click", function (e) {
      var b = e.target.closest(".btn-back[data-goto]"); if (b) switchTab(b.getAttribute("data-goto"));
    });
    $("log-search").addEventListener("input", function () { renderLogList(this.value); });
    $("btn-export").addEventListener("click", function () { exportCSV(); });

    // Admin
    $("dash-refresh").addEventListener("click", function () { adminLoad(true); });
    $("an-refresh").addEventListener("click", function () { adminLoad(true); });
    $("an-period").addEventListener("change", renderAnalytics);
    $("stock-refresh").addEventListener("click", function () { adminLoad(true); });
    $("stock-export").addEventListener("click", exportStockCSV);
    // จัดการบัญชี
    $("user-add").addEventListener("click", function () { openUserModal("add"); });
    $("u-cancel").addEventListener("click", function () { hide($("user-modal")); });
    $("u-save").addEventListener("click", saveUser);
    $("user-modal").addEventListener("click", function (e) { if (e.target === $("user-modal")) hide($("user-modal")); });
    $("users-body").addEventListener("click", function (e) {
      var ed = e.target.closest(".u-edit"); if (ed) { openUserModal("edit", ed.getAttribute("data-badge")); return; }
      var dl = e.target.closest(".u-del"); if (dl) askDeleteUser(dl.getAttribute("data-badge"));
    });
    $("ah-search").addEventListener("input", function () { renderAdminHistory(this.value); });
    $("ah-from").addEventListener("change", function () { renderAdminHistory($("ah-search").value); });
    $("ah-to").addEventListener("change", function () { renderAdminHistory($("ah-search").value); });
    $("ah-export").addEventListener("click", function () { exportCSV(adminData.records); });
    $("dash-report").addEventListener("click", printReport);
    $("btn-print-slip").addEventListener("click", printSlip);
    $("stock-body").addEventListener("click", function (e) { var b = e.target.closest(".btn-add-stock"); if (b) addStockFromBtn(b); });
    $("stock-body").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { var inp = e.target.closest(".stock-in"); if (inp) { e.preventDefault(); var b = inp.parentNode.querySelector(".btn-add-stock"); if (b) addStockFromBtn(b); } }
    });
    $("tab-dashboard").addEventListener("click", function (e) {
      var b = e.target.closest(".ov-foot[data-goto]"); if (b) switchTab(b.getAttribute("data-goto"));
    });
    // ลบ/ล้างประวัติ (ต้องใส่ PIN)
    $("ah-clear").addEventListener("click", askClearRecords);
    $("ah-body").addEventListener("click", function (e) {
      var d = e.target.closest(".btn-del-row"); if (d) { askDeleteRecord(d.getAttribute("data-code")); return; }
      var ed = e.target.closest(".btn-edit-row"); if (ed) openEdit(ed.getAttribute("data-code"));
    });
    $("edit-cancel").addEventListener("click", function () { hide($("edit-modal")); });
    $("edit-ok").addEventListener("click", saveEdit);
    $("edit-symptom").addEventListener("change", function () {
      if (isOther(this.value)) show($("edit-symptom-other")); else { hide($("edit-symptom-other")); $("edit-symptom-other").value = ""; }
    });
    $("edit-modal").addEventListener("click", function (e) { if (e.target === $("edit-modal")) hide($("edit-modal")); });
    $("pin-cancel").addEventListener("click", closePin);
    $("pin-ok").addEventListener("click", submitPin);
    $("pin-input").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); submitPin(); } });
    $("pin-modal").addEventListener("click", function (e) { if (e.target === $("pin-modal")) closePin(); });

    // เมนูค้นหา (ซ่อน/แสดง)
    $("btn-more").addEventListener("click", toggleMore);
    document.addEventListener("click", function (e) {
      if (!e.target.closest(".nav-more")) hide($("more-menu"));
    });
    // ช่องค้นหา
    $("search-name-input").addEventListener("input", searchByName);
    $("search-dept-select").addEventListener("change", searchByDept);
    // ปุ่ม "เลือก" ในตารางผลค้นหา (event delegation)
    ["search-name-results", "search-dept-results"].forEach(function (id) {
      $(id).addEventListener("click", function (e) {
        var b = e.target.closest(".btn-pick"); if (b) pickEmployee(b.getAttribute("data-id"));
      });
    });

    $("symptom").addEventListener("change", onSymptomChange);

    setConnBadge();
    tickClock(); setInterval(tickClock, 1000);
    updateQueueBadge();
    window.addEventListener("online", syncQueue);
    setInterval(syncQueue, 30000);
    populateSymptoms();

    // คืน session ทันที (ไม่ต้องรอโหลดฐานข้อมูล) — กันเด้งออกหน้า login ตอนรีเฟรช
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(LS_SESSION)); } catch (e) {}
    if (saved && saved.code) startSession(saved);

    // โหลดฐานข้อมูลจริงเบื้องหลัง แล้วอัปเดต dropdown/ข้อมูลให้เป็นตัวล่าสุด
    if (USE_API) toast("กำลังเชื่อมฐานข้อมูล…");
    bootstrapData().catch(function (e) {
      if (USE_API) toast("เชื่อมฐานข้อมูลไม่สำเร็จ ใช้ข้อมูลออฟไลน์ชั่วคราว: " + e.message);
    }).then(function () {
      populateSymptoms();
      // ถ้าเป็นพยาบาลและยังไม่ได้กรอกอะไร → สร้างฟอร์มใหม่ด้วยข้อมูลสด
      if (currentNurse && !isAdminRole(currentNurse.role) && !currentEmp && !$("symptom").value) resetForm();
      syncQueue();   // ส่งคิวออฟไลน์ที่ค้างอยู่
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
