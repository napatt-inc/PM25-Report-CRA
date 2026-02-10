module.exports = async (req, res) => {
    // =================================================================
    // 🟠 ส่วนที่ 1: แก้ไขลิงก์ Google Sheet ของคุณตรงนี้ (เหมือนเดิม)
    // =================================================================
    const SHEET_CSV_URL = 'ใส่_LINK_GOOGLE_SHEET_CSV_ของคุณตรงนี้'; 
    // =================================================================

    let airData = {};
    let postData = null;

    // --- ฟังก์ชันดึงข้อมูล Air4Thai (เพิ่ม PM10, O3) ---
    const getAir4Thai = async () => {
        const response = await fetch('http://air4thai.pcd.go.th/services/getNewAQI_JSON.php', {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Referer': 'http://air4thai.pcd.go.th/'
            },
            signal: AbortSignal.timeout(8000)
        });
        if (!response.ok) throw new Error('Air4Thai Server Error');
        const data = await response.json();
        
        // ค้นหาสถานี (Logic เดิม)
        let stations = data.stations || data.station || [];
        if (!Array.isArray(stations)) stations = [];
        
        let target = stations.find(s => (s.nameTH && s.nameTH.includes("หลักสี่")) || (s.areaTH && s.areaTH.includes("หลักสี่")) || (s.areaTH && s.areaTH.includes("ทุ่งสองห้อง")));
        if (!target) target = stations.find(s => (s.nameTH && s.nameTH.includes("บางเขน")));
        if (!target) target = stations.find(s => (s.areaTH && s.areaTH.includes("ดินแดง")));

        if (!target) throw new Error('Station not found');

        // ฟังก์ชันช่วยดึงค่า (กัน Error ถ้าไม่มีข้อมูล)
        const getVal = (param) => (target.LastUpdate[param] && target.LastUpdate[param].value && target.LastUpdate[param].value !== "-") ? target.LastUpdate[param].value : "N/A";

        return {
            source: 'Air4Thai',
            aqi: target.AQI.aqi,
            pm25: getVal('PM25'),
            pm10: getVal('PM10'), // เพิ่ม PM10
            o3: getVal('O3'),     // เพิ่ม O3
            status: target.AQI.p_level,
            color: target.AQI.color,
            time: (target.LastUpdate.date + " " + target.LastUpdate.time),
            location: target.areaTH
        };
    };

    // --- ฟังก์ชันสำรอง (OpenMeteo) ---
    const getBackupAir = async () => {
        const lat = 13.88; const lon = 100.57;
        // ดึง pm10 กับ ozone เพิ่ม
        const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=pm2_5,pm10,ozone,us_aqi&timezone=Asia%2FBangkok`;
        
        const response = await fetch(url);
        const data = await response.json();
        
        const aqi = data.current.us_aqi;
        
        let status = "ปานกลาง"; let color = "#FFF176"; // สีเหลือง
        if (aqi <= 50) { status = "ดีมาก"; color = "#4FC3F7"; } // ฟ้า
        else if (aqi <= 100) { status = "ดี"; color = "#81C784"; } // เขียว
        else if (aqi > 150) { status = "เริ่มมีผลกระทบ"; color = "#FFB74D"; } // ส้ม
        else if (aqi > 200) { status = "มีผลกระทบ"; color = "#E57373"; } // แดง

        return {
            source: 'OpenMeteo (สำรอง)',
            aqi: aqi,
            pm25: data.current.pm2_5,
            pm10: data.current.pm10,  // เพิ่ม PM10
            o3: data.current.ozone,   // เพิ่ม O3
            status: status,
            color: color,
            time: data.current.time.replace('T', ' '),
            location: "หลักสี่ (Backup Data)"
        };
    };

    // --- เริ่มทำงานจริง (เหมือนเดิม) ---
    try {
        try { airData = await getAir4Thai(); } 
        catch (e) { 
            console.log("Air4Thai Failed, switching to backup...", e.message);
            try { airData = await getBackupAir(); } 
            catch (backupError) { airData = { error: "ไม่สามารถดึงข้อมูลได้เลยทั้ง 2 แหล่ง" }; }
        }

        // ดึง Google Sheet (เหมือนเดิม)
        try {
            if (SHEET_CSV_URL.includes('http')) {
                const sheetRes = await fetch(SHEET_CSV_URL);
                const sheetText = await sheetRes.text();
                const rows = sheetText.split('\n');
                if (rows.length > 1) {
                    let lastRowStr = rows[rows.length - 1];
                    if (lastRowStr.trim() === '') lastRowStr = rows[rows.length - 2];
                    const matches = lastRowStr.match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g);
                    const columns = matches || lastRowStr.split(',');
                    if(columns && columns.length >= 2) {
                        const clean = (str) => str ? str.replace(/^"|"$/g, '').trim() : '';
                        postData = {
                            timestamp: clean(columns[0]),
                            type: clean(columns[1]),
                            title: clean(columns[2]) || 'ไม่มีหัวข้อ',
                            fileUrl: clean(columns[3]) || '#'
                        };
                    }
                }
            }
        } catch (sheetError) { console.log("Sheet Error:", sheetError); }

        res.status(200).json({ air: airData, post: postData });

    } catch (criticalError) {
        res.status(500).json({ error: criticalError.message });
    }
};
