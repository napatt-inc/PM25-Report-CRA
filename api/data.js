const axios = require('axios');
const Papa = require('papaparse'); // เราจะใช้ CDN ในฝั่ง Client หรือใช้ fetch CSV แบบง่ายๆ

// ฟังก์ชันสำหรับ Vercel Serverless (Node.js)
module.exports = async (req, res) => {
  try {
    // 1. ดึงข้อมูล Air4Thai (Server-side fetching ไม่กลัว HTTP)
    const airRes = await axios.get('http://air4thai.pcd.go.th/services/getNewAQI_JSON.php', {
      headers: { 'User-Agent': 'Mozilla/5.0' } // หลอกว่าเป็น Browser
    });
    
    // Logic ค้นหาเขตหลักสี่ (เหมือนเดิม)
    let stations = airRes.data.stations || airRes.data.station;
    let target = stations.find(s => s.nameTH.includes("หลักสี่") || s.areaTH.includes("หลักสี่") || s.areaTH.includes("ทุ่งสองห้อง"));
    if (!target) target = stations.find(s => s.nameTH.includes("บางเขน"));
    if (!target) target = stations.find(s => s.areaTH.includes("ดินแดง"));

    const pmData = target ? {
      aqi: target.AQI.aqi,
      pm25: target.LastUpdate.PM25.value,
      status: target.AQI.p_level,
      color: target.AQI.color,
      time: target.LastUpdate.date + " " + target.LastUpdate.time,
      location: target.areaTH
    } : { error: "Not Found" };

    // 2. ดึงข้อมูลประกาศจาก Google Sheet (CSV)
    // ใส่ Link CSV ที่คุณ Copy มาจากขั้นตอนที่ 1 ตรงนี้
    const SHEET_CSV_URL = 'LINK_GOOGLE_SHEET_CSV_OF_YOURS_HERE'; 
    
    let latestPost = null;
    if(SHEET_CSV_URL.startsWith('http')) {
        const sheetRes = await axios.get(SHEET_CSV_URL);
        // แปลง CSV เป็น JSON ง่ายๆ (เอาบรรทัดสุดท้าย)
        const rows = sheetRes.data.split('\n');
        if (rows.length > 1) {
            // สมมติ Column: Timestamp, Type, Title, FileUrl
            // CSV แถวสุดท้ายคือข้อมูลล่าสุด
            const lastRow = rows[rows.length - 1].split(','); 
            // หมายเหตุ: การ Split CSV แบบง่ายอาจมีปัญหาถ้าข้อความมีเครื่องหมายจุลภาค แต่ใช้เบื้องต้นได้
            latestPost = {
                timestamp: lastRow[0],
                type: lastRow[1],
                title: lastRow[2],
                fileUrl: lastRow[3] ? lastRow[3].replace(/"/g, '').trim() : '' // ลบเครื่องหมายคำพูดออก
            };
        }
    }

    // 3. ส่งข้อมูลกลับไปที่หน้าเว็บ
    res.status(200).json({
      air: pmData,
      post: latestPost
    });

  } catch (error) {
    res.status(500).json({ error: error.toString() });
  }
};