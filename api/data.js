module.exports = async (req, res) => {
    // =================================================================
    // 🟠 ส่วนที่ 1: ลิงก์ Google Sheet สำหรับประกาศ (คงเดิมไว้)
    // =================================================================
    const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSoa90gy2q_JHhquiUHEYcJA_O-JI0ntib_9NG8heNoGv-GEtco9Bv-bWiSib3vrg7E85Dz5H7JnlWO/pub?gid=0&single=true&output=csv'; 
    // =================================================================

    let airData = {};
    let postData = null;

    // --- ฟังก์ชันดึงข้อมูล Air4Thai (จาก Link Region 1 ที่ให้มา) ---
    const getAir4Thai = async () => {
        const targetUrl = 'http://air4thai.pcd.go.th/services/getNewAQI_JSON.php?region=1';
        
        const response = await fetch(targetUrl, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Referer': 'http://air4thai.pcd.go.th/'
            },
            signal: AbortSignal.timeout(8000)
        });

        if (!response.ok) throw new Error('Air4Thai Server Error');
        
        const data = await response.json();
        
        // ข้อมูล Region 1 มักจะอยู่ใน key ชื่อ "stations"
        let stations = data.stations || data;
        if (!Array.isArray(stations)) {
             // เผื่อ API เปลี่ยนรูปแบบเป็น Object เดี่ยว
             stations = [stations];
        }
        
        // 🔍 ระบบค้นหาสถานี (Logic: หลักสี่ -> ทุ่งสองห้อง -> มหาวิทยาลัยเกษตร -> บางเขน)
        let target = stations.find(s => (s.nameTH && s.nameTH.includes("หลักสี่")) || (s.areaTH && s.areaTH.includes("หลักสี่")));
        
        if (!target) target = stations.find(s => (s.areaTH && s.areaTH.includes("ทุ่งสองห้อง")));
        if (!target) target = stations.find(s => (s.nameTH && s.nameTH.includes("มหาวิทยาลัยเกษตร"))); // ใกล้หลักสี่มาก
        if (!target) target = stations.find(s => (s.nameTH && s.nameTH.includes("บางเขน")));

        // ถ้าหาไม่เจอจริงๆ ให้เอาตัวแรกของ list (ส่วนมากคือ กรมประชาสัมพันธ์ หรือ ดินแดง)
        if (!target && stations.length > 0) target = stations[0];
        if (!target) throw new Error('No Station found in Region 1');

        // ฟังก์ชันช่วยดึงค่า (กัน Error ถ้าค่าเป็น "-")
        // โครงสร้าง Region 1: params จะอยู่ใน LastUpdate
        const getVal = (paramName) => {
            try {
                const item = target.LastUpdate[paramName];
                if (item && item.value && item.value !== "-") return item.value;
                return "N/A";
            } catch (e) { return "N/A"; }
        };

        const getAqi = () => {
            // AQI อาจจะอยู่ใน LastUpdate.AQI.aqi หรือ AQI.aqi
            if (target.LastUpdate && target.LastUpdate.AQI && target.LastUpdate.AQI.aqi && target.LastUpdate.AQI.aqi !== "-") return target.LastUpdate.AQI.aqi;
            if (target.AQI && target.AQI.aqi && target.AQI.aqi !== "-") return target.AQI.aqi;
            return "N/A";
        }

        // แปลงระดับ AQI เป็นข้อความสถานะ
        const aqiVal = parseFloat(getAqi());
        let statusText = "รอข้อมูล";
        if (!isNaN(aqiVal)) {
            if (aqiVal <= 25) statusText = "คุณภาพดีมาก";
            else if (aqiVal <= 50) statusText = "คุณภาพดี";
            else if (aqiVal <= 100) statusText = "ปานกลาง";
            else if (aqiVal <= 200) statusText = "เริ่มมีผลกระทบ";
            else statusText = "มีผลกระทบต่อสุขภาพ";
        } else {
             // ถ้าหา AQI ไม่เจอ ให้ลองดู field "Level"
             if (target.LastUpdate && target.LastUpdate.AQI && target.LastUpdate.AQI.Level) {
                 const lvl = target.LastUpdate.AQI.Level;
                 if(lvl == 1) statusText = "คุณภาพดีมาก";
                 if(lvl == 2) statusText = "คุณภาพดี";
                 if(lvl == 3) statusText = "ปานกลาง";
                 if(lvl == 4) statusText = "เริ่มมีผลกระทบ";
                 if(lvl == 5) statusText = "มีผลกระทบต่อสุขภาพ";
             }
        }

        return {
            source: 'Air4Thai (Region 1)',
            aqi: getAqi(),
            pm25: getVal('PM25'),
            pm10: getVal('PM10'),
            o3: getVal('O3'),
            status: statusText,
            color: "", // UI จะคำนวณสีเองจากค่า AQI
            time: (target.LastUpdate.date + " " + target.LastUpdate.time),
            location: target.nameTH + " " + target.areaTH
        };
    };

    // --- ฟังก์ชันสำรอง (OpenMeteo) ---
    const getBackupAir = async () => {
        // พิกัดเขตหลักสี่
        const lat = 13.887; const lon = 100.587; 
        const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=pm2_5,pm10,ozone,us_aqi&timezone=Asia%2FBangkok`;
        
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

    // --- ส่วน Google Sheet (เหมือนเดิม) ---
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
                    let inQuotes = false;
                    let currentVal = '';
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
        } catch (e) { console.log("Sheet Error", e); }
        return null;
    };

    // --- Main Logic ---
    try {
        // พยายามดึง Air4Thai ก่อน
        try { 
            airData = await getAir4Thai(); 
        } catch (e) { 
            console.log("Air4Thai Region 1 Failed:", e.message);
            // ถ้าพัง ให้ดึง OpenMeteo แทน
            try { airData = await getBackupAir(); }
            catch (bkError) { airData = { error: "Data Unavailable" }; }
        }

        // ดึงประกาศ
        postData = await getSheetData();

        res.status(200).json({ air: airData, post: postData });

    } catch (criticalError) {
        res.status(500).json({ error: criticalError.message });
    }
};
