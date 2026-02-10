module.exports = async (req, res) => {
    // ตั้งค่า Header ให้รองรับ CORS (กรณีรันคนละโดเมน)
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );

    // ถ้าเป็น OPTIONS request ให้จบการทำงานเลย
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    // ลิงก์ API
    const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSoa90gy2q_JHhquiUHEYcJA_O-JI0ntib_9NG8heNoGv-GEtco9Bv-bWiSib3vrg7E85Dz5H7JnlWO/pub?gid=0&single=true&output=csv';
    const AIR4THAI_URL = 'http://air4thai.pcd.go.th/services/getNewAQI_JSON.php?region=1';
    const OPENMETEO_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=13.887&longitude=100.579&current=pm10,ozone&timezone=Asia%2FBangkok';

    // ฟังก์ชันดึงข้อมูล Air4Thai (AQI & PM2.5)
    const getAirData = async () => {
        let finalData = {
            aqi: "-",
            pm25: "-",
            pm10: "-",
            o3: "-",
            status: "รอข้อมูล",
            time: "-",
            location: "เขตหลักสี่ (Hybrid)",
            source: "Air4Thai + OpenMeteo"
        };

        try {
            // 1. ดึง Air4Thai
            const airRes = await fetch(AIR4THAI_URL, { 
                headers: { 'User-Agent': 'Mozilla/5.0' },
                signal: AbortSignal.timeout(8000) // รอไม่เกิน 8 วิ
            });
            
            if (airRes.ok) {
                const data = await airRes.json();
                const stations = data.stations || data;
                // หาเขตหลักสี่ (bkp97t)
                const target = stations.find(s => s.stationID === "bkp97t");

                if (target) {
                    finalData.location = target.nameTH;
                    
                    // เจาะจงข้อมูลที่ AQILast ตาม JSON ที่คุณให้มา
                    const info = target.AQILast || target.LastUpdate;

                    if (info) {
                        // วันที่และเวลา
                        if (info.date && info.time) {
                            finalData.time = `${info.date} ${info.time}`;
                        }

                        // PM 2.5
                        if (info.PM25 && info.PM25.value && info.PM25.value !== "-1") {
                            finalData.pm25 = info.PM25.value;
                        }

                        // AQI & Status
                        if (info.AQI) {
                            if (info.AQI.aqi && info.AQI.aqi !== "-999") finalData.aqi = info.AQI.aqi;
                            
                            // แปลงระดับสีเป็นข้อความ
                            const lvl = info.AQI.color_id || "0";
                            const levels = ["", "คุณภาพดีมาก", "คุณภาพดี", "ปานกลาง", "เริ่มมีผลกระทบ", "มีผลกระทบต่อสุขภาพ"];
                            finalData.status = levels[Number(lvl)] || "ปานกลาง";
                        }
                    }
                }
            }
        } catch (e) {
            console.error("Air4Thai Error:", e.message);
        }

        try {
            // 2. ดึง OpenMeteo (PM10 & O3)
            const omRes = await fetch(OPENMETEO_URL, { signal: AbortSignal.timeout(5000) });
            if (omRes.ok) {
                const omData = await omRes.json();
                
                // เติมค่าที่ขาด
                finalData.pm10 = omData.current.pm10;
                finalData.o3 = omData.current.ozone;

                // ถ้า Air4Thai ล่ม ไม่มีเวลา ให้ใช้เวลาจาก OpenMeteo แทน
                if (finalData.time === "-") {
                    finalData.time = omData.current.time.replace('T', ' ');
                }
            }
        } catch (e) {
            console.error("OpenMeteo Error:", e.message);
        }

        return finalData;
    };

    // ฟังก์ชันดึงประกาศจาก Google Sheet (CSV)
    const getSheetData = async () => {
        try {
            // ใส่ ?t=... กัน Cache
            const res = await fetch(SHEET_CSV_URL + '&t=' + new Date().getTime());
            const text = await res.text();
            
            // แปลง CSV แบบง่ายๆ
            const rows = text.split(/\r?\n/).filter(row => row.trim() !== "");
            
            // อ่านบรรทัดสุดท้าย
            if (rows.length > 1) {
                const lastRowStr = rows[rows.length - 1];
                
                // Regex แยกคอลัมน์โดยไม่สนเครื่องหมาย , ใน quote ""
                const matches = lastRowStr.match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g);
                
                if (matches) {
                     const cols = matches.map(c => c.replace(/^"|"$/g, '').trim()); // ลบ quote ออก
                     
                     // ตรวจสอบว่ามีข้อมูลครบไหม (Timestamp, Type, Title, URL)
                     if(cols.length >= 3) {
                        return {
                            timestamp: cols[0] || '',
                            type: cols[1] || 'text',
                            title: cols[2] || 'ประกาศ',
                            fileUrl: cols[3] || '#'
                        };
                     }
                } else {
                    // Fallback ถ้า Regex ไม่เจอ (กรณี CSV ธรรมดา)
                    const simpleCols = lastRowStr.split(',');
                    if(simpleCols.length >= 3) {
                         return {
                            timestamp: simpleCols[0],
                            type: simpleCols[1],
                            title: simpleCols[2],
                            fileUrl: simpleCols[3] || '#'
                        };
                    }
                }
            }
        } catch (e) {
            console.error("Sheet Error:", e.message);
        }
        return null;
    };

    try {
        // ทำงานพร้อมกัน (Parallel) เพื่อความไว
        const [airData, postData] = await Promise.all([getAirData(), getSheetData()]);
        
        // ส่งผลลัพธ์กลับ
        res.status(200).json({ air: airData, post: postData });

    } catch (criticalError) {
        res.status(500).json({ error: criticalError.message });
    }
};
