/**************************************************************
 * MLCare - Google Apps Script backend (Web App)
 * ผูกกับ Google Sheet ที่เก็บข้อมูล (Extensions > Apps Script)
 *
 * แท็บที่ใช้:
 *   User      : ชื่อ | รหัสส่วนตัว | Pin | ประเภท user
 *   พนักงาน    : รหัสพนักงาน | คำนำหน้า | ชื่อ | นามสกุล | ชื่ออังกฤษ |
 *               ตำแหน่ง | ด้าน | ฝ่าย | แผนก | กลุ่มพนักงาน | วันเกิด | อายุ
 *   ประเภทยา   : ชื่อยา | หน่วย | อาการที่รักษา
 *   อาการ      : อาการ / สาเหตุ
 *   บันทึก     : (สร้างอัตโนมัติ) เก็บผลการบันทึกการใช้บริการ
 *
 * Deploy: Deploy > New deployment > Web app
 *   - Execute as: Me
 *   - Who has access: Anyone
 *   นำ URL ที่ได้ (.../exec) ไปวางใน config.js -> API_URL
 **************************************************************/

var SS = SpreadsheetApp.getActive();

/* (แนะนำ) ตั้งรหัสลับให้ตรงกับ API_TOKEN ใน config.js เพื่อกันคนอื่นเรียก API
   เว้นว่าง '' = ไม่ตรวจ token */
var TOKEN = 'mlcare2026key';

var RECORDS_SHEET = 'บันทึก';
var RECORD_HEADERS = ['โค้ด','วันที่-เวลา','รหัสพยาบาล','ชื่อพยาบาล','รหัสพนักงาน',
  'ชื่อ-สกุล','เพศ','อายุ','ตำแหน่ง','ด้าน','ฝ่าย','แผนก','กลุ่ม',
  'อาการ','ยาที่เบิก','หมายเหตุ','สถานะ'];

/* ---------- Router ---------- */
function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'bootstrap';
  if (TOKEN && (!e || !e.parameter || e.parameter.token !== TOKEN)) return json({ ok: false, error: 'unauthorized' });
  if (action === 'records') return json({ ok: true, records: getRecords() });
  if (action === 'history') return json({ ok: true, records: getRecords(e.parameter.empId) });
  if (action === 'stock')   return json({ ok: true, stock: getStock() });
  if (action === 'movements') return json({ ok: true, movements: getMovements(200) });
  if (action === 'ping')    return json({ ok: true, time: new Date().toISOString() });
  return json(bootstrapCached(e && e.parameter && e.parameter.fresh));
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents || '{}');
    if (TOKEN && body.token !== TOKEN) return json({ ok: false, error: 'unauthorized' });
    if (body.action === 'addRecord') return json(addRecord(body.payload || {}));
    if (body.action === 'addStock')  return json(addStock(body.payload || {}));
    if (body.action === 'adjustStock') return json(adjustStock(body.payload || {}));
    if (body.action === 'addMedicine') return json(addMedicine(body.payload || {}));
    if (body.action === 'deleteMedicine') return json(deleteMedicine(body.payload || {}));
    if (body.action === 'clearStock') return json(clearStock(body.payload || {}));
    if (body.action === 'clearMovements') return json(clearMovements(body.payload || {}));
    if (body.action === 'deleteRecord') return json(deleteRecord(body.payload || {}));
    if (body.action === 'updateRecord') return json(updateRecord(body.payload || {}));
    if (body.action === 'clearRecords') return json(clearRecords(body.payload || {}));
    if (body.action === 'changePin')   return json(changePin(body.payload || {}));
    if (body.action === 'addUser')     return json(addUser(body.payload || {}));
    if (body.action === 'updateUser')  return json(updateUser(body.payload || {}));
    if (body.action === 'deleteUser')  return json(deleteUser(body.payload || {}));
    return json({ ok: false, error: 'unknown action: ' + body.action });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ---------- อ่าน master data ---------- */
function values(name) {
  var sh = SS.getSheetByName(name);
  if (!sh) return [];
  return sh.getDataRange().getValues();
}
function S(v) { return (v == null ? '' : String(v)).replace(/\.0$/, '').trim(); }

function bootstrap() {
  return {
    ok: true,
    users: parseUsers(),
    employees: parseEmployees(),
    medicines: parseMedicines(),
    symptoms: parseSymptoms()
  };
}

/* ---- cache bootstrap (gzip) ให้โหลดเร็ว ---- */
var BOOT_CACHE_KEY = 'boot_v1';
var BOOT_CACHE_TTL = 1800;   // 30 นาที
function bootstrapCached(force) {
  var cache = CacheService.getScriptCache();
  if (!force) {
    var z = cache.get(BOOT_CACHE_KEY);
    if (z) {
      try {
        var blob = Utilities.newBlob(Utilities.base64Decode(z), 'application/x-gzip');
        var obj = JSON.parse(Utilities.ungzip(blob).getDataAsString('UTF-8'));
        obj.cached = true; return obj;
      } catch (err) { /* rebuild */ }
    }
  }
  var data = bootstrap();
  try {
    var gz = Utilities.gzip(Utilities.newBlob(JSON.stringify(data), 'application/json'));
    cache.put(BOOT_CACHE_KEY, Utilities.base64Encode(gz.getBytes()), BOOT_CACHE_TTL);
  } catch (err) { /* ใหญ่เกิน/พลาด = ไม่ cache ก็ได้ */ }
  return data;
}
function clearBootCache() { try { CacheService.getScriptCache().remove(BOOT_CACHE_KEY); } catch (e) {} }

function parseUsers() {
  var v = values('User'), out = [];
  for (var i = 1; i < v.length; i++) {
    var name = S(v[i][0]); if (!name) continue;
    var badge = S(v[i][1]);
    var pin = S(v[i][2]);
    var role = S(v[i][3]);
    var digits = badge.replace(/\D/g, '');
    var code = digits ? ('00' + digits).slice(-2) : badge.slice(-2);
    out.push({ name: name, badge: badge, pin: pin, role: role, code: code });
  }
  return out;
}

function parseEmployees() {
  var v = values('พนักงาน'), out = [];
  for (var i = 1; i < v.length; i++) {
    var id = S(v[i][0]); if (!id) continue;
    var prefix = S(v[i][1]), first = S(v[i][2]), last = S(v[i][3]), eng = S(v[i][4]);
    var gender = '-';
    if (/^\s*Mr/i.test(eng)) gender = 'ชาย';
    else if (/^\s*(Ms|Mrs|Miss)/i.test(eng)) gender = 'หญิง';
    else if (prefix.indexOf('นาง') === 0) gender = 'หญิง';
    else if (prefix.indexOf('นาย') === 0 || prefix.indexOf('ท้าว') === 0) gender = 'ชาย';
    var age = ageFromBirth(v[i][10]);          // คำนวณจากวันเกิด (คอลัมน์ K)
    if (age === '') age = S(v[i][11]);          // สำรอง: ใช้คอลัมน์อายุถ้ามี
    out.push({
      id: id, prefix: prefix, firstName: first, lastName: last, engName: eng,
      position: S(v[i][5]), sector: S(v[i][6]), division: S(v[i][7]),
      department: S(v[i][8]), group: S(v[i][9]),
      birth: fmtBirth(v[i][10]), age: age, gender: gender
    });
  }
  return out;
}

/* แปลงค่าวันเกิดเป็น Date (รองรับทั้ง Date object และข้อความ d/m/yyyy) */
function toBirthDate(b) {
  if (!b && b !== 0) return null;
  if (Object.prototype.toString.call(b) === '[object Date]') return isNaN(b.getTime()) ? null : b;
  var s = S(b);
  if (!s) return null;
  var m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    var d = parseInt(m[1], 10), mo = parseInt(m[2], 10), y = parseInt(m[3], 10);
    if (y < 100) y += 2000;
    if (y > 2400) y -= 543;                 // เผื่อกรอกเป็น พ.ศ.
    var dt = new Date(y, mo - 1, d);
    return isNaN(dt.getTime()) ? null : dt;
  }
  var dt2 = new Date(s);
  return isNaN(dt2.getTime()) ? null : dt2;
}

function ageFromBirth(b) {
  var d = toBirthDate(b);
  if (!d) return '';
  var now = new Date();
  var a = now.getFullYear() - d.getFullYear();
  if (now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate())) a--;
  return (a >= 0 && a < 130) ? String(a) : '';
}

function fmtBirth(b) {
  var d = toBirthDate(b);
  if (!d) return '';
  var p = function (n) { return ('0' + n).slice(-2); };
  return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear();
}

function isNoDispense(name) { return /ไม่จ่าย|ไม่ได้จ่าย/.test(name || ''); }

function parseMedicines() {
  var v = values('ประเภทยา'), out = [];
  for (var i = 1; i < v.length; i++) {
    var name = S(v[i][0]); if (!name || isNoDispense(name)) continue;
    out.push({ name: name, unit: S(v[i][1]), treats: S(v[i][2]) });
  }
  return out;
}

function parseSymptoms() {
  var v = values('อาการ'), out = [];
  for (var i = 1; i < v.length; i++) {
    var s = S(v[i][0]); if (s) out.push(s);
  }
  return out;
}

/* ---------- บันทึก (เขียน) ---------- */
function getRecordsSheet() {
  var sh = SS.getSheetByName(RECORDS_SHEET);
  if (!sh) {
    sh = SS.insertSheet(RECORDS_SHEET);
    sh.appendRow(RECORD_HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function getRecords(empId) {
  var sh = SS.getSheetByName(RECORDS_SHEET);
  if (!sh) return [];
  var v = sh.getDataRange().getValues();
  var filter = empId ? S(empId) : null;
  var out = [];
  for (var i = 1; i < v.length; i++) {
    var r = v[i];
    if (!r[0]) continue;
    if (filter && S(r[4]) !== filter) continue;
    out.push({
      code: S(r[0]), datetime: r[1] ? new Date(r[1]).toISOString() : '',
      nurseCode: S(r[2]), nurseName: S(r[3]), empId: S(r[4]), empName: S(r[5]),
      gender: S(r[6]), age: S(r[7]), position: S(r[8]), sector: S(r[9]),
      division: S(r[10]), department: S(r[11]), group: S(r[12]),
      symptom: S(r[13]), medsText: S(r[14]), note: S(r[15]), status: S(r[16])
    });
  }
  return out;
}

/* ทะเบียนโค้ดถาวร — จดทุกโค้ดที่เคยออก เพื่อการันตีว่าโค้ด 6 หลัก "ไม่มีทางซ้ำ"
   แม้บันทึกจะถูกลบ/ล้างประวัติไปแล้วก็ตาม */
var CODES_SHEET = 'โค้ดที่ออกแล้ว';
function getCodesSheet() {
  var sh = SS.getSheetByName(CODES_SHEET);
  if (!sh) { sh = SS.insertSheet(CODES_SHEET); sh.appendRow(['โค้ด', 'ออกเมื่อ']); sh.setFrozenRows(1); sh.hideSheet(); }
  return sh;
}

function addRecord(p) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000); // กันโค้ดซ้ำเมื่อบันทึกพร้อมกันหลายเครื่อง
  try {
    var sh = getRecordsSheet();
    var nurseCode = S(p.nurseCode) || '00';

    // โค้ด 6 หลัก — ห้ามซ้ำกับ "ทุกโค้ดที่เคยออก" (ทะเบียนถาวร + บันทึกปัจจุบัน)
    var data = sh.getDataRange().getValues();
    var used = {};
    for (var i = 1; i < data.length; i++) used[S(data[i][0])] = true;
    var csh = getCodesSheet();
    var cv = csh.getDataRange().getValues();
    for (var c = 1; c < cv.length; c++) used[S(cv[c][0])] = true;
    var code = S(p.code);
    if (!code || used[code]) {
      var tries = 0;
      do { code = '' + Math.floor(100000 + Math.random() * 900000); tries++; } while (used[code] && tries < 3000000);
      if (used[code]) return { ok: false, error: 'โค้ด 6 หลักถูกใช้ครบทุกหมายเลขแล้ว (900,000 โค้ด)' };
    }
    csh.appendRow([code, new Date()]);   // จดเข้าทะเบียนถาวรทันที

    var when = p.datetime ? new Date(p.datetime) : new Date();
    if (isNaN(when.getTime())) when = new Date();

    var meds = p.meds || [];
    var shortErr = checkStock(meds);         // #2 กันจ่ายเกินสต๊อก
    if (shortErr) return { ok: false, error: shortErr };
    var medsText = meds.map(function (m) {
      return m.name + ' x' + (m.qty || '-') + ' ' + (m.unit || '');
    }).join(' | ');

    sh.appendRow([
      code, when, nurseCode, S(p.nurseName), S(p.empId),
      S(p.empName), S(p.gender), S(p.age), S(p.position), S(p.sector),
      S(p.division), S(p.department), S(p.group),
      S(p.symptom), medsText, S(p.note)
    ]);

    deductStock(meds, code, S(p.nurseName));   // ตัดสต๊อกยาที่จ่ายจริง
    return { ok: true, code: code };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    lock.releaseLock();
  }
}

/* ============================================================
   สต๊อกยา
   ============================================================ */
var STOCK_SHEET = 'สต๊อกยา';
var STOCK_HEADERS = ['ชื่อยา', 'หน่วย', 'คงเหลือ', 'ปรับล่าสุด', 'วันหมดอายุ'];
var MOVE_SHEET = 'สต๊อกเคลื่อนไหว';
var MOVE_HEADERS = ['เวลา', 'ชื่อยา', 'ประเภท', 'จำนวน', 'คงเหลือหลัง', 'อ้างอิง', 'โดย'];

/* ---- คลังแบบแยกล็อต (แต่ละครั้งรับเข้า = 1 แถวล็อต) ---- */
var LOTS_SHEET = 'ล็อตยา';
var LOTS_HEADERS = ['ชื่อยา', 'หน่วย', 'คงเหลือ', 'วันหมดอายุ', 'รับเข้าเมื่อ'];

function getLotsSheet() {
  var sh = SS.getSheetByName(LOTS_SHEET);
  if (!sh) { sh = SS.insertSheet(LOTS_SHEET); sh.appendRow(LOTS_HEADERS); sh.setFrozenRows(1); }
  return sh;
}

/* รวมล็อตเป็นรายยา: total + รายการล็อต */
function getStock() {
  var sh = getLotsSheet();
  var v = sh.getDataRange().getValues();
  var map = {}, order = [];
  for (var i = 1; i < v.length; i++) {
    var name = S(v[i][0]); if (!name || isNoDispense(name)) continue;
    var qty = Number(v[i][2]) || 0;
    if (!map[name]) { map[name] = { name: name, unit: S(v[i][1]), qty: 0, lots: [] }; order.push(name); }
    map[name].qty += qty;
    if (qty > 0) map[name].lots.push({
      qty: qty,
      expiry: v[i][3] ? new Date(v[i][3]).toISOString() : '',
      received: v[i][4] ? new Date(v[i][4]).toISOString() : ''
    });
  }
  var out = []; for (var k = 0; k < order.length; k++) out.push(map[order[k]]);
  return out;
}

function medTotal(sh, name) {
  var v = sh.getDataRange().getValues(), t = 0;
  for (var i = 1; i < v.length; i++) if (S(v[i][0]) === S(name)) t += Number(v[i][2]) || 0;
  return t;
}

function logMove(name, type, qty, balance, ref, by) {
  var sh = SS.getSheetByName(MOVE_SHEET);
  if (!sh) { sh = SS.insertSheet(MOVE_SHEET); sh.appendRow(MOVE_HEADERS); sh.setFrozenRows(1); }
  sh.appendRow([new Date(), name, type, qty, balance, ref || '', by || '']);
}

function getMovements(limit) {
  var sh = SS.getSheetByName(MOVE_SHEET);
  if (!sh) return [];
  var v = sh.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < v.length; i++) {
    if (!v[i][1]) continue;
    out.push({
      time: v[i][0] ? new Date(v[i][0]).toISOString() : '',
      name: S(v[i][1]), type: S(v[i][2]), qty: Number(v[i][3]) || 0,
      balance: Number(v[i][4]) || 0, ref: S(v[i][5]), by: S(v[i][6])
    });
  }
  out.reverse();
  return limit ? out.slice(0, limit) : out;
}

/* รับเข้า = เพิ่มล็อตใหม่ 1 แถว (จำนวน + วันหมดอายุของล็อตนั้น) */
function addStock(p) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var name = S(p.name), qty = parseInt(p.qty, 10), unit = S(p.unit), by = S(p.by);
    if (!name || isNaN(qty) || qty <= 0) return { ok: false, error: 'ข้อมูลไม่ถูกต้อง' };
    var sh = getLotsSheet();
    var exp = ''; if (S(p.expiry)) { var ed = new Date(S(p.expiry)); if (!isNaN(ed.getTime())) exp = ed; }
    sh.appendRow([name, unit, qty, exp, new Date()]);
    var total = medTotal(sh, name);
    logMove(name, 'รับเข้า', qty, total, '', by);
    return { ok: true, name: name, balance: total };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    lock.releaseLock();
  }
}

/* ปรับยอดคงเหลือให้เท่าจำนวนที่นับจริง (แอดมิน)
   - เพิ่ม: สร้างล็อตปรับยอดใหม่ (ใส่วันหมดอายุได้)
   - ลด: ตัดจากล็อตหมดอายุก่อน (FEFO) */
function adjustStock(p) {
  var lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    var name = S(p.name), target = parseInt(p.qty, 10), by = S(p.by);
    if (!name || isNaN(target) || target < 0) return { ok: false, error: 'ข้อมูลไม่ถูกต้อง' };
    var sh = getLotsSheet();
    var cur = medTotal(sh, name);
    if (target === cur) return { ok: true, balance: cur, delta: 0 };
    if (target > cur) {
      var exp = ''; if (S(p.expiry)) { var ed = new Date(S(p.expiry)); if (!isNaN(ed.getTime())) exp = ed; }
      sh.appendRow([name, S(p.unit), target - cur, exp, new Date()]);
    } else {
      var need = cur - target;
      var v = sh.getDataRange().getValues(), rows = [];
      for (var r = 1; r < v.length; r++) {
        if (S(v[r][0]) === name && (Number(v[r][2]) || 0) > 0)
          rows.push({ row: r + 1, qty: Number(v[r][2]) || 0, exp: v[r][3] ? new Date(v[r][3]).getTime() : 8.64e15 });
      }
      rows.sort(function (a, b) { return a.exp - b.exp; });
      for (var j = 0; j < rows.length && need > 0; j++) {
        var take = Math.min(need, rows[j].qty);
        sh.getRange(rows[j].row, 3).setValue(rows[j].qty - take);
        need -= take;
      }
    }
    var total = medTotal(sh, name);
    logMove(name, 'ปรับยอด', target - cur, total, '', by);
    return { ok: true, balance: total, delta: target - cur };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally { lock.releaseLock(); }
}

/* เพิ่มรายการยาใหม่เข้าแคตตาล็อก (แท็บ "ประเภทยา") — ต้องยืนยัน PIN แอดมิน */
function addMedicine(p) {
  if (!isAdminPin(p.adminPin)) return { ok: false, error: 'PIN ผู้ดูแลไม่ถูกต้อง' };
  var name = S(p.name), unit = S(p.unit), treats = S(p.treats);
  if (!name || !unit) return { ok: false, error: 'กรอกชื่อยาและหน่วยให้ครบ' };
  var lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    var sh = SS.getSheetByName('ประเภทยา');
    if (!sh) return { ok: false, error: 'ไม่พบชีต ประเภทยา' };
    var v = sh.getDataRange().getValues();
    for (var i = 1; i < v.length; i++) if (S(v[i][0]) === name) return { ok: false, error: 'มียา “' + name + '” อยู่แล้ว' };
    sh.appendRow([name, unit, treats]);
    logAudit('เพิ่มรายการยา', name + ' (' + unit + ')', p.adminPin);
    clearBootCache();
    return { ok: true };
  } finally { lock.releaseLock(); }
}

/* ลบรายการยาออกจากแคตตาล็อก — ต้องยืนยัน PIN แอดมิน
   กันพลาด: ถ้ายังมีสต๊อกเหลือ ต้องปรับยอดเป็น 0 ก่อน */
function deleteMedicine(p) {
  if (!isAdminPin(p.adminPin)) return { ok: false, error: 'PIN ผู้ดูแลไม่ถูกต้อง' };
  var name = S(p.name);
  if (!name) return { ok: false, error: 'ไม่ระบุชื่อยา' };
  var lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    var lots = SS.getSheetByName(LOTS_SHEET);
    if (lots) {
      var remain = medTotal(lots, name);
      if (remain > 0) return { ok: false, error: 'ยา “' + name + '” ยังมีสต๊อกเหลือ ' + remain + ' — ปรับยอดเป็น 0 ก่อนลบ' };
      var lv = lots.getDataRange().getValues();
      for (var r = lv.length - 1; r >= 1; r--) if (S(lv[r][0]) === name) lots.deleteRow(r + 1);  // เก็บกวาดล็อตเปล่า
    }
    var sh = SS.getSheetByName('ประเภทยา');
    if (!sh) return { ok: false, error: 'ไม่พบชีต ประเภทยา' };
    var v = sh.getDataRange().getValues();
    for (var i = v.length - 1; i >= 1; i--) {
      if (S(v[i][0]) === name) {
        sh.deleteRow(i + 1);
        logAudit('ลบรายการยา', name, p.adminPin);
        clearBootCache();
        return { ok: true };
      }
    }
    return { ok: false, error: 'ไม่พบยา “' + name + '” ในแคตตาล็อก' };
  } finally { lock.releaseLock(); }
}

/* ล้างสต๊อกทั้งหมด = ลบทุกแถวล็อต (คงหัวตาราง) ทำให้ยาทุกตัวเหลือ 0
   ถ้าส่ง payload.name มา จะล้างเฉพาะยาตัวนั้น */
function clearStock(p) {
  var lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    var sh = SS.getSheetByName(LOTS_SHEET);
    if (!sh) return { ok: true, cleared: 0 };
    var only = p && S(p.name);
    var removed = 0;
    if (only) {
      var v = sh.getDataRange().getValues();
      for (var i = v.length - 1; i >= 1; i--) {
        if (S(v[i][0]) === only) { sh.deleteRow(i + 1); removed++; }
      }
      logMove(only, 'ล้างสต๊อก', 0, 0, '', S(p.by) || 'admin');
    } else {
      var n = sh.getLastRow() - 1;
      if (n > 0) { sh.deleteRows(2, n); removed = n; }
    }
    return { ok: true, cleared: removed };
  } finally { lock.releaseLock(); }
}

/* ล้างประวัติการเคลื่อนไหวสต๊อก (รับเข้า/จ่ายออก) — ลบทุกแถว คงหัวตาราง */
function clearMovements(p) {
  var lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    var sh = SS.getSheetByName(MOVE_SHEET);
    if (!sh) return { ok: true, cleared: 0 };
    var n = sh.getLastRow() - 1;
    if (n > 0) sh.deleteRows(2, n);
    return { ok: true, cleared: n > 0 ? n : 0 };
  } finally { lock.releaseLock(); }
}

/* จ่ายออก = ตัดจากล็อตที่หมดอายุก่อน (ล็อตไม่มีวันหมดอายุ = ตัดท้ายสุด) */
function deductStock(meds, ref, by) {
  var sh = getLotsSheet();
  for (var i = 0; i < meds.length; i++) {
    var m = meds[i];
    if (!m || !m.name || isNoDispense(m.name)) continue;
    var need = parseInt(m.qty, 10);
    if (isNaN(need) || need <= 0) continue;
    var v = sh.getDataRange().getValues(), rows = [];
    for (var r = 1; r < v.length; r++) {
      if (S(v[r][0]) === S(m.name) && (Number(v[r][2]) || 0) > 0)
        rows.push({ row: r + 1, qty: Number(v[r][2]) || 0, exp: v[r][3] ? new Date(v[r][3]).getTime() : 8.64e15 });
    }
    rows.sort(function (a, b) { return a.exp - b.exp; });
    for (var j = 0; j < rows.length && need > 0; j++) {
      var take = Math.min(need, rows[j].qty);
      sh.getRange(rows[j].row, 3).setValue(rows[j].qty - take);
      need -= take;
    }
    logMove(m.name, 'จ่ายออก', parseInt(m.qty, 10), medTotal(sh, m.name), ref, by);
  }
}

/* ============================================================
   ลบ/ล้างประวัติ (ต้องยืนยันด้วย PIN ของผู้ดูแลระบบ)
   ============================================================ */
function isAdminPin(pin) {
  var users = parseUsers();
  for (var i = 0; i < users.length; i++) {
    if (users[i].pin && S(users[i].pin) === S(pin) && /admin/i.test(users[i].role)) return true;
  }
  return false;
}
function adminNameFromPin(pin) {
  var users = parseUsers();
  for (var i = 0; i < users.length; i++) if (S(users[i].pin) === S(pin) && /admin/i.test(users[i].role)) return users[i].name + ' (' + users[i].badge + ')';
  return 'admin';
}
/* บันทึกร่องรอยการแก้ไข/ลบ (accountability) */
function logAudit(action, detail, byPin) {
  var sh = SS.getSheetByName('Audit');
  if (!sh) { sh = SS.insertSheet('Audit'); sh.appendRow(['เวลา', 'การกระทำ', 'รายละเอียด', 'โดย']); sh.setFrozenRows(1); }
  sh.appendRow([new Date(), action, detail, adminNameFromPin(byPin)]);
}
function deleteRecord(p) {
  if (!isAdminPin(p.pin)) return { ok: false, error: 'PIN ไม่ถูกต้อง' };
  var lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    var sh = SS.getSheetByName(RECORDS_SHEET);
    if (!sh) return { ok: false, error: 'ไม่มีข้อมูล' };
    var v = sh.getDataRange().getValues();
    for (var i = v.length - 1; i >= 1; i--) {
      if (S(v[i][0]) === S(p.code)) { sh.deleteRow(i + 1); logAudit('ลบบันทึก', 'โค้ด ' + S(p.code) + ' (' + S(v[i][5]) + ' · ' + S(v[i][13]) + ')', p.pin); return { ok: true, code: S(p.code) }; }
    }
    return { ok: false, error: 'ไม่พบโค้ด ' + S(p.code) };
  } finally { lock.releaseLock(); }
}
function clearRecords(p) {
  if (!isAdminPin(p.pin)) return { ok: false, error: 'PIN ไม่ถูกต้อง' };
  var lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    var sh = SS.getSheetByName(RECORDS_SHEET);
    if (!sh) return { ok: true, cleared: 0 };
    var n = sh.getLastRow() - 1;
    if (n > 0) sh.deleteRows(2, n);
    logAudit('ล้างประวัติทั้งหมด', 'ลบ ' + n + ' รายการ', p.pin);
    return { ok: true, cleared: n };
  } finally { lock.releaseLock(); }
}

/* #5 แก้ไขรายการ (symptom/หมายเหตุ) + ทำเครื่องหมายว่าแก้ไข */
function updateRecord(p) {
  if (!isAdminPin(p.pin)) return { ok: false, error: 'PIN ไม่ถูกต้อง' };
  var lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    var sh = SS.getSheetByName(RECORDS_SHEET);
    if (!sh) return { ok: false, error: 'ไม่มีข้อมูล' };
    var v = sh.getDataRange().getValues();
    for (var i = 1; i < v.length; i++) {
      if (S(v[i][0]) === S(p.code)) {
        var row = i + 1;
        if (p.symptom != null) sh.getRange(row, 14).setValue(S(p.symptom));
        if (p.note != null) sh.getRange(row, 16).setValue(S(p.note));
        var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm');
        sh.getRange(row, 17).setValue('✎ แก้ไข ' + stamp + (p.by ? ' โดย ' + S(p.by) : ''));
        logAudit('แก้ไขบันทึก', 'โค้ด ' + S(p.code), p.pin);
        return { ok: true, code: S(p.code) };
      }
    }
    return { ok: false, error: 'ไม่พบโค้ด ' + S(p.code) };
  } finally { lock.releaseLock(); }
}

/* เปลี่ยน PIN ของผู้ใช้ (ตรวจ PIN ปัจจุบันก่อน) */
function changePin(p) {
  var newPin = S(p.newPin);
  if (!/^\d{4,}$/.test(newPin)) return { ok: false, error: 'PIN ใหม่ต้องเป็นตัวเลขอย่างน้อย 4 หลัก' };
  var lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    var sh = SS.getSheetByName('User');
    if (!sh) return { ok: false, error: 'ไม่พบผู้ใช้' };
    var v = sh.getDataRange().getValues();
    for (var i = 1; i < v.length; i++) {
      if (S(v[i][1]) === S(p.badge)) {
        if (S(v[i][2]) !== S(p.currentPin)) return { ok: false, error: 'PIN ปัจจุบันไม่ถูกต้อง' };
        sh.getRange(i + 1, 3).setValue(newPin);
        return { ok: true };
      }
    }
    return { ok: false, error: 'ไม่พบผู้ใช้ ' + S(p.badge) };
  } finally { lock.releaseLock(); }
}

/* ============================================================
   จัดการบัญชีผู้ใช้ (แอดมิน) — เพิ่ม/แก้ไข/ลบ
   ============================================================ */
function findUserRow(sh, badge) {
  var v = sh.getDataRange().getValues();
  for (var i = 1; i < v.length; i++) if (S(v[i][1]) === S(badge)) return i + 1;
  return -1;
}
function addUser(p) {
  if (!isAdminPin(p.adminPin)) return { ok: false, error: 'PIN ผู้ดูแลไม่ถูกต้อง' };
  var name = S(p.name), badge = S(p.badge), pin = S(p.pin), role = S(p.role) || 'recoder';
  if (!name || !badge || !pin) return { ok: false, error: 'กรอกข้อมูลไม่ครบ' };
  if (!/^\d{4,}$/.test(pin)) return { ok: false, error: 'PIN ต้องเป็นตัวเลขอย่างน้อย 4 หลัก' };
  var lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    var sh = SS.getSheetByName('User'); if (!sh) return { ok: false, error: 'ไม่พบชีต User' };
    if (findUserRow(sh, badge) > 0) return { ok: false, error: 'Badge “' + badge + '” มีอยู่แล้ว' };
    sh.appendRow([name, badge, pin, role]);
    clearBootCache();
    return { ok: true };
  } finally { lock.releaseLock(); }
}
function updateUser(p) {
  if (!isAdminPin(p.adminPin)) return { ok: false, error: 'PIN ผู้ดูแลไม่ถูกต้อง' };
  var lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    var sh = SS.getSheetByName('User'); if (!sh) return { ok: false, error: 'ไม่พบชีต User' };
    var r = findUserRow(sh, S(p.badge));
    if (r < 0) return { ok: false, error: 'ไม่พบผู้ใช้' };
    if (p.newBadge && S(p.newBadge) !== S(p.badge) && findUserRow(sh, S(p.newBadge)) > 0)
      return { ok: false, error: 'Badge ใหม่ซ้ำกับที่มีอยู่' };
    if (p.pin && !/^\d{4,}$/.test(S(p.pin))) return { ok: false, error: 'PIN ต้องเป็นตัวเลขอย่างน้อย 4 หลัก' };
    if (p.name != null && S(p.name)) sh.getRange(r, 1).setValue(S(p.name));
    if (p.newBadge && S(p.newBadge)) sh.getRange(r, 2).setValue(S(p.newBadge));
    if (p.pin && S(p.pin)) sh.getRange(r, 3).setValue(S(p.pin));
    if (p.role != null && S(p.role)) sh.getRange(r, 4).setValue(S(p.role));
    clearBootCache();
    return { ok: true };
  } finally { lock.releaseLock(); }
}
function deleteUser(p) {
  if (!isAdminPin(p.adminPin)) return { ok: false, error: 'PIN ผู้ดูแลไม่ถูกต้อง' };
  var lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    var sh = SS.getSheetByName('User'); if (!sh) return { ok: false, error: 'ไม่พบชีต User' };
    var r = findUserRow(sh, S(p.badge));
    if (r < 0) return { ok: false, error: 'ไม่พบผู้ใช้' };
    sh.deleteRow(r);
    logAudit('ลบบัญชีผู้ใช้', 'Badge ' + S(p.badge), p.adminPin);
    clearBootCache();
    return { ok: true };
  } finally { lock.releaseLock(); }
}

/* #2 ตรวจสต๊อกก่อนจ่าย: รวมทุกล็อต ถ้าไม่พอให้ error */
function checkStock(meds) {
  var sh = SS.getSheetByName(LOTS_SHEET);
  if (!sh) return null;                 // ยังไม่มีคลัง = ไม่บล็อก
  var v = sh.getDataRange().getValues(), totals = {};
  for (var i = 1; i < v.length; i++) { var n = S(v[i][0]); if (!n) continue; totals[n] = (totals[n] || 0) + (Number(v[i][2]) || 0); }
  for (var j = 0; j < meds.length; j++) {
    var m = meds[j];
    if (!m || !m.name || isNoDispense(m.name)) continue;
    var q = parseInt(m.qty, 10); if (isNaN(q) || q <= 0) continue;
    if (totals.hasOwnProperty(S(m.name)) && q > totals[S(m.name)]) {
      return 'ยา “' + m.name + '” คงเหลือไม่พอ (มี ' + totals[S(m.name)] + ' ' + (m.unit || '') + ' ต้องจ่าย ' + q + ')';
    }
  }
  return null;
}

/* #14 สำรองข้อมูล — คัดลอกทั้งไฟล์ไป Google Drive
   ตั้ง schedule: รันฟังก์ชัน installMonthlyBackup() ครั้งเดียวในตัวแก้ไข */
function backupNow() {
  var name = SS.getName() + ' (สำรอง ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd_HHmm') + ')';
  var file = DriveApp.getFileById(SS.getId()).makeCopy(name);
  return file.getId();
}
function installMonthlyBackup() {
  var tg = ScriptApp.getProjectTriggers();
  for (var i = 0; i < tg.length; i++) if (tg[i].getHandlerFunction() === 'backupNow') ScriptApp.deleteTrigger(tg[i]);
  ScriptApp.newTrigger('backupNow').timeBased().onMonthDay(1).atHour(1).create();
  return 'ตั้งสำรองอัตโนมัติทุกวันที่ 1 เวลา 01:00 แล้ว';
}
