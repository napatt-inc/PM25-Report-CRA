module.exports = async (req, res) => {
    const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSoa90gy2q_JHhquiUHEYcJA_O-JI0ntib_9NG8heNoGv-GEtco9Bv-bWiSib3vrg7E85Dz5H7JnlWO/pub?gid=0&single=true&output=csv'; 

    // ตั้งค่า Timeout ให้สั้นลง (5 วินาที) ถ้า Air4Thai ช้ากว่านี้ ให้ตัดไปใช้ Backup ทันที
    // เพื่อไม่ให้ Vercel หมุนติ้วจน Error
    const TIMEOUT_MS = 5000; 

    let airData = {};
    let postData = null;

    // --- 1. Air4Thai (Main Source) ---
    const getAir4Thai = async () => {
        console.log("Connecting to Air4Thai (HTTP via Proxy)...");
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

        try {
            const response = await fetch('http://air4thai.pcd.go.th/services/getNewAQI_JSON.php?region=1', {
                method: 'GET',
                // ✅ ใส่ Headers เพื่อหลอก Server ว่าเราคือ Chrome (แก้ปัญหาโดนบล็อก)
                headers: { 
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'application/json, text/plain, */*',
                    'Referer': 'http://air4thai.pcd.go.th/',
                    'Connection': 'keep-alive'
                },
                signal: controller.signal
            });

            clearTimeout(timeoutId); // ยกเลิกตัวจับเวลาถ้าโหลดเสร็จทัน

            if (!response.ok) throw new Error(`HTTP Status: ${response.status}`);
            
            const data = await response.json();
            const stations = Array.isArray(data.stations) ? data.stations : [data];

            // 🎯 ค้นหา bkp97t (เขตหลักสี่)
            let target = stations.find(s => s.stationID === "bkp97t");
            
            // Backup: หา บางเขน
            if (!target) target = stations.find(s => s.nameTH.includes("บางเขน"));

            if (!target) throw new Error('Station Not Found');

            // Helper ดึงค่า
            const getVal = (param) => {
                try {
                    const item = target.LastUpdate[param];
                    if (item && item.value && item.value !== "N/A" && item.value !== "-") return item.value;
                    return "-";
                } catch { return "-"; }
            };

            const getAqi = () => {
                if (target.LastUpdate?.AQI?.aqi && target.LastUpdate.AQI.aqi !== "N/A") return target.LastUpdate.AQI.aqi;
                if (target.AQI?.aqi && target.AQI.aqi !== "N/A") return target.AQI.aqi;
                return "-";
            };

            return {
                source: 'Air4Thai',
                aqi: getAqi(),
                pm25: getVal('PM25'),
                pm10: getVal('PM10'),
                o3: getVal('O3'),
                status: target.LastUpdate?.AQI?.Level ? getStatusFromLevel(target.LastUpdate.AQI.Level) : "รอข้อมูล",
                time: (target.LastUpdate.date + " " + target.LastUpdate.time),
                location: target.nameTH
            };

        } catch (error) {
            clearTimeout(timeoutId);
            throw error; // ส่ง error ไปให้ catch ด้านล่างทำงานต่อ
        }
    };

    const getStatusFromLevel = (lvl) => {
        if(lvl == 1) return "คุณภาพดีมาก";
        if(lvl == 2) return "คุณภาพดี";
        if(lvl == 3) return "ปานกลาง";
        if(lvl == 4) return "เริ่มมีผลกระทบ";
        if(lvl == 5) return "มีผลกระทบต่อสุขภาพ";
        return "รอข้อมูล";
    }

    // --- 2. OpenMeteo (Backup Source) ---
    const getBackupAir = async () => {
        console.log("Switching to OpenMeteo...");
        // พิกัดหลักสี่
        const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=13.887&longitude=100.579&current=pm2_5,pm10,ozone,us_aqi&timezone=Asia%2FBangkok`;
        
        const response = await fetch(url);
        const data = await response.json();
        const aqi = data.current.us_aqi;
        
        let status = "ปานกลาง";
        if (aqi <= 50) status = "คุณภาพดีมาก";
        else if (aqi <= 100) status = "คุณภาพดี";
        else if (aqi > 150) status = "เริ่มมีผลกระทบ";
        else if (aqi > 200) status = "มีผลกระทบ";

        return {
            source: 'OpenMeteo (Backup)',
            aqi: aqi,
            pm25: data.current.pm2_5,
            pm10: data.current.pm10,
            o3: data.current.ozone,
            status: status,
            time: data.current.time.replace('T', ' '),
            location: "หลักสี่ (Backup Data)"
        };
    };

    // --- 3. Google Sheet ---
    const getSheetData = async () => {
        try {
            const sheetRes = await fetch(SHEET_CSV_URL);
            const sheetText = await sheetRes.text();
            const rows = sheetText.split(/\r?\n/);
            if (rows.length > 1) {
                let lastRowStr = rows[rows.length - 1];
                if (!lastRowStr || lastRowStr.trim() === '') lastRowStr = rows[rows.length - 2];
                if (lastRowStr) {
                    const columns = [];
                    let inQuotes = false; let currentVal = '';
                    for (let char of lastRowStr) {
                        if (char === '"') { inQuotes = !inQuotes; }
                        else if (char === ',' && !inQuotes) { columns.push(currentVal); currentVal = ''; }
                        else { currentVal += char; }
                    }
                    columns.push(currentVal);
                    const clean = (str) => str ? str.trim().replace(/^"|"$/g, '').replace(/""/g, '"') : '';
                    if(columns.length >= 3) {
                        return {
                            timestamp: clean(columns[0]),
                            type: clean(columns[1]),
                            title: clean(columns[2]) || 'ประกาศ',
                            fileUrl: clean(columns[3]) || '#'
                        };
                    }
                }
            }
        } catch (e) { console.log("Sheet Error"); }
        return null;
    };

    // --- Main Logic ---
    try {
        // พยายามดึง Air4Thai ก่อน
        try { 
            airData = await getAir4Thai(); 
        } catch (e) { 
            console.log(`Air4Thai Failed (${e.message}), Using Backup.`);
            // ถ้า Air4Thai พัง หรือ ช้าเกิน 5 วิ -> ใช้ Backup ทันที
            try { airData = await getBackupAir(); }
            catch (bkError) { airData = { error: "Unavailable" }; }
        }

        postData = await getSheetData();

        // สำคัญ: Vercel Function ตอบกลับเป็น HTTPS เสมอ
        // Browser จึงไม่บ่นเรื่อง Mixed Content
        res.status(200).json({ air: airData, post: postData });

    } catch (criticalError) {
        res.status(500).json({ error: criticalError.message });
    }
};
