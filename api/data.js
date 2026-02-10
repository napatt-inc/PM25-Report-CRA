module.exports = async (req, res) => {
    const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSoa90gy2q_JHhquiUHEYcJA_O-JI0ntib_9NG8heNoGv-GEtco9Bv-bWiSib3vrg7E85Dz5H7JnlWO/pub?gid=0&single=true&output=csv'; 
    
    // ลองเปลี่ยนมาใช้ Endpoint V2 ที่แอป Air4Thai ใช้ (มักจะเสถียรกว่า)
    const AIR4THAI_URL = 'http://air4thai.pcd.go.th/forappV2/getAQI_JSON.php';

    let airData = {};
    let postData = null;
    let debugMessage = ""; // ตัวแปรเก็บข้อความ Error เพื่อดูสาเหตุ

    // --- 1. Air4Thai (V2 Mobile Endpoint) ---
    const getAir4Thai = async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000); // รอ 6 วินาที

        try {
            const response = await fetch(AIR4THAI_URL, {
                headers: { 
                    'User-Agent': 'okhttp/3.14.9', // ปลอมตัวเป็น Mobile App Android
                    'Accept': 'application/json'
                },
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) throw new Error(`HTTP Error ${response.status}`);
            
            const data = await response.json();
            const stations = data.stations || [];

            // 🎯 ค้นหา ID: bkp97t (สำนักงานเขตหลักสี่)
            let target = stations.find(s => s.stationID === "bkp97t");
            
            // Backup 1: บางเขน (bkp53t)
            if (!target) target = stations.find(s => s.stationID === "bkp53t");
            
            // Backup 2: ค้นหาด้วยชื่อ
            if (!target) target = stations.find(s => s.nameTH.includes("หลักสี่") || s.nameTH.includes("บางเขน"));

            if (!target) throw new Error('Station Not Found in V2 List');

            // ดึงค่า (V2 โครงสร้างอาจต่างนิดหน่อย แต่ปกติคล้ายเดิม)
            const getVal = (param) => {
                if (target.AQI[param] && target.AQI[param] !== "-") return target.AQI[param];
                if (target.LastUpdate[param] && target.LastUpdate[param].value !== "-") return target.LastUpdate[param].value;
                return "-";
            };

            const aqi = target.AQI.aqi !== "-" ? target.AQI.aqi : "-";
            if (aqi === "-") throw new Error('AQI is empty');

            return {
                source: 'Air4Thai',
                aqi: aqi,
                pm25: getVal('PM25'),
                pm10: getVal('PM10'),
                o3: getVal('O3'),
                status: target.AQI.getLevel ? getStatusFromLevel(target.AQI.getLevel) : "รอข้อมูล",
                time: (target.date + " " + target.time),
                location: target.nameTH
            };

        } catch (error) {
            clearTimeout(timeoutId);
            debugMessage = error.message; // เก็บ Error ไว้ดู
            throw error;
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

    // --- 2. OpenMeteo (Backup) ---
    const getBackupAir = async () => {
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
            debug_info: `Air4Thai Failed: ${debugMessage}`, // ส่ง Error กลับไปให้เห็นที่หน้าเว็บ
            aqi: aqi,
            pm25: data.current.pm2_5,
            pm10: data.current.pm10,
            o3: data.current.ozone,
            status: status,
            time: data.current.time.replace('T', ' '),
            location: "หลักสี่ (Backup Data)"
        };
    };

    // --- 3. Sheet Data ---
    const getSheetData = async () => {
        try {
            const sheetRes = await fetch(SHEET_CSV_URL);
            const sheetText = await sheetRes.text();
            // ... (Logic ตัดคำเดิม) ...
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
        } catch (e) { }
        return null;
    };

    try {
        try { 
            airData = await getAir4Thai(); 
        } catch (e) { 
            console.log("Air4Thai Error:", e.message);
            try { airData = await getBackupAir(); }
            catch (bkError) { airData = { error: "Unavailable" }; }
        }

        postData = await getSheetData();
        res.status(200).json({ air: airData, post: postData });

    } catch (criticalError) {
        res.status(500).json({ error: criticalError.message });
    }
};
