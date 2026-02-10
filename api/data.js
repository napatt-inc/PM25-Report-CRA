module.exports = async (req, res) => {
    // =================================================================
    // ลิงก์ Google Sheet ประกาศ (คงเดิม)
    // =================================================================
    const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSoa90gy2q_JHhquiUHEYcJA_O-JI0ntib_9NG8heNoGv-GEtco9Bv-bWiSib3vrg7E85Dz5H7JnlWO/pub?gid=0&single=true&output=csv'; 
    // =================================================================

    let airData = {};
    let postData = null;

    // --- 1. ฟังก์ชันดึง Air4Thai (เจาะจง ID: bkp97t) ---
    const getAir4Thai = async () => {
        console.log("Fetching Air4Thai Region 1...");

        // ใช้ JSON Endpoint (ข้อมูลชุดเดียวกับ XML แต่จัดการง่ายกว่า)
        const response = await fetch('http://air4thai.pcd.go.th/services/getNewAQI_JSON.php?region=1', {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            signal: AbortSignal.timeout(10000) // รอสูงสุด 10 วินาที
        });

        if (!response.ok) throw new Error('Connect Air4Thai Failed');
        
        const data = await response.json();
        const stations = Array.isArray(data.stations) ? data.stations : [data];

        // 🎯 1. ค้นหาด้วยรหัสสถานี "bkp97t" (สำนักงานเขตหลักสี่) ก่อนเป็นอันดับแรก
        let target = stations.find(s => s.stationID === "bkp97t");

        // 🎯 2. ถ้าเขตหลักสี่ (bkp97t) ปิดปรับปรุง ให้หา "บางเขน" (bkp53t) มาสำรอง
        if (!target) {
            console.log("ไม่เจอ bkp97t กำลังหา backup...");
            target = stations.find(s => s.nameTH.includes("บางเขน"));
        }

        if (!target) throw new Error('Station Not Found');

        // ฟังก์ชันดึงค่า (จัดการกับค่า "N/A" จาก XML ที่คุณเจอ)
        const getVal = (param) => {
            try {
                // เช็คว่ามี key นี้ไหม และค่าต้องไม่ใช่ "N/A" และไม่ใช่ "-"
                if (target.LastUpdate[param] && 
                    target.LastUpdate[param].value !== "N/A" && 
                    target.LastUpdate[param].value !== "-") {
                    return target.LastUpdate[param].value;
                }
                return "-"; // ถ้าไม่มีค่า ให้ส่งขีดไปแทน (อย่าส่ง Error)
            } catch (e) {
                return "-";
            }
        };

        const getAqi = () => {
             // AQI บางทีอยู่ใน AQI object บางทีอยู่ใน LastUpdate
             if (target.LastUpdate?.AQI?.aqi && target.LastUpdate.AQI.aqi !== "N/A") return target.LastUpdate.AQI.aqi;
             if (target.AQI?.aqi && target.AQI.aqi !== "N/A") return target.AQI.aqi;
             // ถ้าหา AQI ไม่ได้ ให้ลองเอา PM2.5 มาคำนวณคร่าวๆ หรือส่ง N/A
             return "N/A";
        }

        // เตรียมข้อมูลส่งกลับ
        return {
            source: 'Air4Thai',
            aqi: getAqi(),
            pm25: getVal('PM25'), // จากภาพของคุณ ค่านี้ควรได้ 37.4
            pm10: getVal('PM10'), // จากภาพของคุณ ค่านี้จะได้ "-"
            o3: getVal('O3'),     // จากภาพของคุณ ค่านี้จะได้ "-"
            status: target.LastUpdate?.AQI?.Level ? getStatusFromLevel(target.LastUpdate.AQI.Level) : "รอข้อมูล",
            time: (target.LastUpdate.date + " " + target.LastUpdate.time),
            location: target.nameTH // ควรขึ้นว่า "สำนักงานเขตหลักสี่"
        };
    };

    // แปลง Level 1-5 เป็นข้อความ
    const getStatusFromLevel = (lvl) => {
        if(lvl == 1) return "คุณภาพดีมาก";
        if(lvl == 2) return "คุณภาพดี";
        if(lvl == 3) return "ปานกลาง";
        if(lvl == 4) return "เริ่มมีผลกระทบ";
        if(lvl == 5) return "มีผลกระทบต่อสุขภาพ";
        return "รอข้อมูล";
    }

    // --- 2. ฟังก์ชันสำรอง OpenMeteo (กรณี Air4Thai ล่ม) ---
    const getBackupAir = async () => {
        const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=13.887&longitude=100.579&current=pm2_5,pm10,ozone,us_aqi&timezone=Asia%2FBangkok`;
        const response = await fetch(url);
        const data = await response.json();
        
        let aqi = data.current.us_aqi;
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
            location: "หลักสี่ (OpenMeteo)"
        };
    };

    // --- 3. ดึงประกาศ (Google Sheet) ---
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
