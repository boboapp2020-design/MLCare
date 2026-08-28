/* ============================================================
   MLCare - การตั้งค่าเชื่อมฐานข้อมูลจริง (Google Sheets)
   ------------------------------------------------------------
   วิธีเปิดใช้:
   1) เปิด Google Sheet ของคุณ > เมนู Extensions > Apps Script
   2) วางโค้ดจากไฟล์ Code.gs ลงไป แล้ว Save
   3) Deploy > New deployment > เลือกชนิด "Web app"
        - Execute as   : Me
        - Who has access: Anyone
   4) กด Deploy แล้วคัดลอก URL ที่ลงท้ายด้วย /exec
   5) นำมาวางในเครื่องหมายคำพูดด้านล่างนี้

   * ถ้าเว้นว่าง ("") ระบบจะทำงานแบบออฟไลน์ (เก็บใน localStorage)
     โดยใช้ข้อมูลตัวอย่างในเครื่อง (employees.js / data.js)
   ============================================================ */

const API_URL = "https://script.google.com/macros/s/AKfycbzvba8q39yZ4U2-pV8zEk2g0Di3OQk4sNb6bpKIXEFLg40X4imOgHxD3WoBQyAKqtiafQ/exec";

/* (แนะนำ) รหัสลับกันคนอื่นเรียก API — ตั้งให้ตรงกับ TOKEN ใน Code.gs
   เว้นว่างได้ถ้ายังไม่ต้องการ */
const API_TOKEN = "mlcare2026key";
