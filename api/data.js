// ไฟล์ api/data.js (ฉบับไม่ต้องติดตั้งอะไรเพิ่ม)
module.exports = async (req, res) => {
  // -------------------------------------------------------
  // 1. ใส่ลิงก์ CSV ของคุณตรงนี้ (อย่าลืมเปลี่ยนนะครับ!)
  // -------------------------------------------------------
  const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-xxxxxx/pub?gid=0&single=true&output=csv'; 

  // เตรียมตัวแปรเก็บข้อมูล
  let airData = { error: "กำลังโหลด..." };
  let postData = null;

  try {
    // --- ส่วนที่ 1: ดึงค่าฝุ่นจาก Air4Thai ---
    try {
        // ใช้ fetch แทน axios (ไม่ต้องลง package เสริม)
        const airRes = await fetch('http://air4thai.pcd.go.th/services/getNewAQI_JSON.php', {
            method: 'GET',
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        
        if (!airRes.ok) throw new Error(`Server status: ${airRes.status}`);
        
        const data = await airRes.json();
        
        // ค้นหาสถานี (Logic เดิม)
        let stations = data.stations || data.station || [];
        // กันพลาดกรณีข้อมูลมาไม่ใช่ Array
        if (!Array.isArray(stations)) stations = [];

        let target = stations.find(s => (s.nameTH && s.nameTH.includes("หลักสี่")) || (s.areaTH && s.areaTH.includes("หลักสี่")) || (s.areaTH && s.areaTH.includes("ทุ่งสองห้อง")));
        if (!target) target = stations.find(s => (s.nameTH && s.nameTH.includes("บางเขน")));
        if (!target) target = stations.find(s => (s.areaTH && s.areaTH.includes("ดินแดง")));

        if (target) {
            airData = {
                aqi: target.AQI.aqi,
                pm25: (target.LastUpdate.PM25 && target.LastUpdate.PM25.value) ? target.LastUpdate.PM25.value : "-",
                status: target.AQI.p_level,
                color: target.AQI.color,
                time: (target.LastUpdate.date + " " + target.LastUpdate.time),
                location: target.areaTH
            };
        } else {
            airData = { error: "ไม่พบข้อมูลสถานี" };
        }
    } catch (airError) {
        console.error("Air4Thai Error:", airError.message);
        airData = { error: "เชื่อมต่อ Air4Thai ไม่ได้" };
    }

    // --- ส่วนที่ 2: ดึงประกาศจาก Google Sheet ---
    try {
        if (SHEET_CSV_URL.includes('http')) {
            const sheetRes = await fetch(SHEET_CSV_URL);
            const sheetText = await sheetRes.text();
            
            const rows = sheetText.split('\n');
            if (rows.length > 1) {
                // เอาบรรทัดสุดท้าย (ข้อมูลล่าสุด)
                const lastRowStr = rows[rows.length - 1];
                // แยกคอมม่า (แบบง่าย)
                const columns = lastRowStr.split(','); 
                
                if(columns.length >= 3) {
                    postData = {
                        // columns[0] คือเวลา, [1] คือประเภท, [2] คือหัวข้อ, [3] คือลิงก์รูป
                        timestamp: columns[0],
                        type: columns[1] ? columns[1].trim() : 'text',
                        title: columns[2] ? columns[2].replace(/"/g, '').trim() : 'ไม่มีหัวข้อ',
                        fileUrl: columns[3] ? columns[3].replace(/"/g, '').trim() : '#'
                    };
                }
            }
        }
    } catch (sheetError) {
        console.error("Sheet Error:", sheetError.message);
    }

    // ส่งข้อมูลกลับ
    res.status(200).json({
      air: airData,
      post: postData
    });

  } catch (criticalError) {
    res.status(500).json({ error: criticalError.message });
  }
};
