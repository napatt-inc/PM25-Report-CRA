module.exports = async (req, res) => {
    // =================================================================
    // 🟠 ส่วนที่ 1: แก้ไขลิงก์ Google Sheet ของคุณตรงนี้ (สำคัญมาก!)
    // =================================================================
    // วิธีเอาลิงก์: ไฟล์ > แชร์ > เผยแพร่ไปที่เว็บ > เลือก csv > คัดลอกลิงก์
    const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSoa90gy2q_JHhquiUHEYcJA_O-JI0ntib_9NG8heNoGv-GEtco9Bv-bWiSib3vrg7E85Dz5H7JnlWO/pub?gid=0&single=true&output=csv'; 
    // ตัวอย่าง: 'https://docs.google.com/spreadsheets/d/e/2PACX-.../pub?output=csv'
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
            signal: AbortSignal.timeout(6000) // รอแค่ 6 วิ ถ้าช้าให้ตัด
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

        return {
            source: 'Air4Thai',
            aqi: target.AQI.aqi,
            pm25: (target.LastUpdate.PM25 && target.LastUpdate.PM25.value) ? target.LastUpdate.PM25.value : "-",
            status: target.AQI.p_level,
            color: target.AQI.color,
            time: (target.LastUpdate.date + " " + target.LastUpdate.time),
            location: target.areaTH
        };
    };

    // --- ฟังก์ชันสำรอง (OpenMeteo) กรณี Air4Thai พัง ---
    const getBackupAir = async () => {
        // พิกัดเขตหลักสี่
        const lat = 13.88; 
        const lon = 100.57;
        const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=pm2_5,us_aqi&timezone=Asia%2FBangkok`;
        
        const response = await fetch(url);
        const data = await response.json();
        
        const pm25 = data.current.pm2_5;
        const aqi = data.current.us_aqi;
        
        // คำนวณสีและสถานะคร่าวๆ เอง (เพราะ API นอกไม่ส่งสีมาให้)
        let status = "ปานกลาง";
        let color = "rgb(255, 193, 7)"; // สีเหลือง
        if (aqi <= 50) { status = "ดีมาก"; color = "rgb(40, 167, 69)"; }
        else if (aqi > 100) { status = "เริ่มมีผลกระทบ"; color = "rgb(255, 152, 0)"; }
        else if (aqi > 200) { status = "อันตราย"; color = "rgb(220, 53, 69)"; }

        return {
            source: 'OpenMeteo (สำรอง)',
            aqi: aqi,
            pm25: pm25,
            status: status,
            color: color,
            time: data.current.time.replace('T', ' '),
            location: "หลักสี่ (Backup Data)"
        };
    };

    // --- เริ่มทำงานจริง ---
    try {
        // 1. ลองดึง Air4Thai ก่อน
        try {
            airData = await getAir4Thai();
        } catch (e) {
            console.log("Air4Thai Failed, switching to backup...", e.message);
            // 2. ถ้าพัง ให้ดึงตัวสำรอง
            try {
                airData = await getBackupAir();
            } catch (backupError) {
                airData = { error: "ไม่สามารถดึงข้อมูลได้เลยทั้ง 2 แหล่ง" };
            }
        }

        // 3. ดึง Google Sheet
        try {
            if (SHEET_CSV_URL.includes('http')) {
                const sheetRes = await fetch(SHEET_CSV_URL);
                const sheetText = await sheetRes.text();
                const rows = sheetText.split('\n');
                
                if (rows.length > 1) {
                    // หาแถวสุดท้ายที่มีข้อมูล (กันบรรทัดว่าง)
                    let lastRowStr = rows[rows.length - 1];
                    if (lastRowStr.trim() === '') lastRowStr = rows[rows.length - 2];

                    // ใช้ Regex แยก CSV เพื่อความแม่นยำกว่า split(',')
                    // รองรับกรณีในเนื้อหามี , ปนอยู่
                    const matches = lastRowStr.match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g);
                    const columns = matches || lastRowStr.split(',');

                    if(columns && columns.length >= 2) {
                        // Clean data (ลบเครื่องหมาย " ออก)
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
        } catch (sheetError) {
            console.log("Sheet Error:", sheetError);
        }

        // ส่งผลลัพธ์
        res.status(200).json({ air: airData, post: postData });

    } catch (criticalError) {
        res.status(500).json({ error: criticalError.message });
    }
};
