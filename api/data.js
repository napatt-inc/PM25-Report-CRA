module.exports = async (req, res) => {
    // =================================================================
    // ✅ ใส่ลิงก์ Google Sheet ของคุณให้เรียบร้อยแล้วครับ
    // =================================================================
    const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSoa90gy2q_JHhquiUHEYcJA_O-JI0ntib_9NG8heNoGv-GEtco9Bv-bWiSib3vrg7E85Dz5H7JnlWO/pub?gid=0&single=true&output=csv'; 
    // =================================================================

    let airData = {};
    let postData = null;

    // --- ฟังก์ชันดึงข้อมูล Air4Thai ---
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
        
        let stations = data.stations || data.station || [];
        if (!Array.isArray(stations)) stations = [];
        
        let target = stations.find(s => (s.nameTH && s.nameTH.includes("หลักสี่")) || (s.areaTH && s.areaTH.includes("หลักสี่")) || (s.areaTH && s.areaTH.includes("ทุ่งสองห้อง")));
        if (!target) target = stations.find(s => (s.nameTH && s.nameTH.includes("บางเขน")));
        if (!target) target = stations.find(s => (s.areaTH && s.areaTH.includes("ดินแดง")));

        if (!target) throw new Error('Station not found');

        const getVal = (param) => (target.LastUpdate[param] && target.LastUpdate[param].value && target.LastUpdate[param].value !== "-") ? target.LastUpdate[param].value : "N/A";

        return {
            source: 'Air4Thai',
            aqi: target.AQI.aqi,
            pm25: getVal('PM25'),
            pm10: getVal('PM10'),
            o3: getVal('O3'),
            status: target.AQI.p_level,
            color: target.AQI.color,
            time: (target.LastUpdate.date + " " + target.LastUpdate.time),
            location: target.areaTH
        };
    };

    // --- ฟังก์ชันสำรอง (OpenMeteo) ---
    const getBackupAir = async () => {
        const lat = 13.88; const lon = 100.57;
        const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=pm2_5,pm10,ozone,us_aqi&timezone=Asia%2FBangkok`;
        
        const response = await fetch(url);
        const data = await response.json();
        
        const aqi = data.current.us_aqi;
        
        let status = "ปานกลาง"; let color = "#FFF176";
        if (aqi <= 50) { status = "ดีมาก"; color = "#4FC3F7"; }
        else if (aqi <= 100) { status = "ดี"; color = "#81C784"; }
        else if (aqi > 150) { status = "เริ่มมีผลกระทบ"; color = "#FFB74D"; }
        else if (aqi > 200) { status = "มีผลกระทบ"; color = "#E57373"; }

        return {
            source: 'OpenMeteo (สำรอง)',
            aqi: aqi,
            pm25: data.current.pm2_5,
            pm10: data.current.pm10,
            o3: data.current.ozone,
            status: status,
            color: color,
            time: data.current.time.replace('T', ' '),
            location: "หลักสี่ (Backup Data)"
        };
    };

    // --- เริ่มทำงาน ---
    try {
        try { airData = await getAir4Thai(); } 
        catch (e) { 
            console.log("Air4Thai Failed, switching to backup...", e.message);
            try { airData = await getBackupAir(); } 
            catch (backupError) { airData = { error: "ไม่สามารถดึงข้อมูลได้เลยทั้ง 2 แหล่ง" }; }
        }

        // --- ส่วนดึงข้อมูล Google Sheet (สำคัญ) ---
        try {
            const sheetRes = await fetch(SHEET_CSV_URL);
            const sheetText = await sheetRes.text();
            
            // แปลง CSV เป็น Array (รองรับภาษาไทยและการเว้นบรรทัด)
            const rows = sheetText.split(/\r?\n/);
            
            // ต้องมีข้อมูลอย่างน้อย 2 บรรทัด (บรรทัด 1 คือหัวข้อ, บรรทัด 2 คือข้อมูล)
            if (rows.length > 1) {
                // หาแถวสุดท้ายที่มีข้อมูลจริง (ตัดแถวว่างทิ้ง)
                let lastRowStr = rows[rows.length - 1];
                if (!lastRowStr || lastRowStr.trim() === '') {
                    lastRowStr = rows[rows.length - 2];
                }

                if (lastRowStr) {
                    // แยกคอลัมน์ด้วยเครื่องหมายจุลภาค (,)
                    // ใช้ Regex เพื่อจัดการกรณีมี , อยู่ในเนื้อหา (เช่น ใน Title)
                    const columns = [];
                    let inQuotes = false;
                    let currentVal = '';
                    
                    for (let char of lastRowStr) {
                        if (char === '"') { inQuotes = !inQuotes; }
                        else if (char === ',' && !inQuotes) { columns.push(currentVal); currentVal = ''; }
                        else { currentVal += char; }
                    }
                    columns.push(currentVal); // push ค่าสุดท้าย

                    // ทำความสะอาดข้อมูล (ลบเครื่องหมาย " ออก)
                    const clean = (str) => str ? str.trim().replace(/^"|"$/g, '').replace(/""/g, '"') : '';

                    if(columns.length >= 3) {
                        postData = {
                            timestamp: clean(columns[0]),
                            type: clean(columns[1]),
                            title: clean(columns[2]) || 'ประกาศ',
                            fileUrl: clean(columns[3]) || '#'
                        };
                    }
                }
            }
        } catch (sheetError) { 
            console.log("Sheet Error:", sheetError); 
        }

        res.status(200).json({ air: airData, post: postData });

    } catch (criticalError) {
        res.status(500).json({ error: criticalError.message });
    }
};
