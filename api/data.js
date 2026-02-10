module.exports = async (req, res) => {
    // -------------------------------------------------------
    // SETUP: ตั้งค่า Header และ URL
    // -------------------------------------------------------
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );

    if (req.method === 'OPTIONS') { res.status(200).end(); return; }

    const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSoa90gy2q_JHhquiUHEYcJA_O-JI0ntib_9NG8heNoGv-GEtco9Bv-bWiSib3vrg7E85Dz5H7JnlWO/pub?gid=0&single=true&output=csv';
    
    // API แหล่งต่างๆ
    const AIRBKK_URL = 'http://www.bangkokairquality.com/bma/json/source_station.php'; // ของ กทม. โดยตรง
    const AIR4THAI_URL = 'http://air4thai.pcd.go.th/services/getNewAQI_JSON.php?region=1'; // ของกรมควบคุมมลพิษ
    const OPENMETEO_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=13.887&longitude=100.579&current=pm10,ozone&timezone=Asia%2FBangkok';

    // -------------------------------------------------------
    // FUNCTION 1: ดึง AirBKK (กทม.)
    // -------------------------------------------------------
    const getAirBKK = async () => {
        try {
            const controller = new AbortController();
            setTimeout(() => controller.abort(), 5000); // Timeout 5 วิ
            
            const res = await fetch(AIRBKK_URL, { signal: controller.signal });
            if (!res.ok) return null;
            
            const data = await res.json();
            // ค้นหาสถานี "เขตหลักสี่"
            const station = data.find(s => {
                const n = s.name || s.station_name || s.nameTH || ""; 
                return n.includes('หลักสี่') || n.includes('Laksi');
            });

            if (station) {
                let pm25Val = parseFloat(station.pm25);
                let aqiVal = station.aqi ? station.aqi : calAQI(pm25Val); 

                return {
                    source: 'AirBKK (สำนักงานเขตหลักสี่)',
                    location: station.name || station.nameTH || 'เขตหลักสี่',
                    time: station.log_datetime || new Date().toLocaleString('th-TH'),
                    pm25: station.pm25,
                    pm10: station.pm10,
                    aqi: aqiVal,
                    status: getAQIStatus(aqiVal)
                };
            }
        } catch (e) { console.error("AirBKK Error:", e.message); }
        return null;
    };

    // -------------------------------------------------------
    // FUNCTION 2: ดึง Air4Thai (สำรอง)
    // -------------------------------------------------------
    const getAir4Thai = async () => {
        try {
            const controller = new AbortController();
            setTimeout(() => controller.abort(), 5000);
            
            const res = await fetch(AIR4THAI_URL, { signal: controller.signal });
            if (!res.ok) return null;
            const data = await res.json();
            const stations = data.stations || data;
            const target = stations.find(s => s.stationID === "bkp97t"); // สถานีหลักสี่กรมวิทย์

            if (target) {
                const info = target.AQILast || target.LastUpdate;
                return {
                    source: 'Air4Thai (กรมควบคุมมลพิษ)',
                    location: target.nameTH,
                    time: `${info.date} ${info.time}`,
                    pm25: info.PM25.value,
                    pm10: "-", 
                    aqi: info.AQI.aqi,
                    status: getAQIStatus(info.AQI.aqi)
                };
            }
        } catch (e) { console.error("Air4Thai Error:", e.message); }
        return null;
    };

    // -------------------------------------------------------
    // FUNCTION 3: ดึง OpenMeteo (เอา Ozone และ PM10 เสริม)
    // -------------------------------------------------------
    const getOpenMeteo = async () => {
        try {
            const res = await fetch(OPENMETEO_URL);
            if (res.ok) {
                const data = await res.json();
                return {
                    o3: data.current.ozone,
                    pm10: data.current.pm10,
                    time: data.current.time
                };
            }
        } catch (e) { console.error("OpenMeteo Error:", e.message); }
        return { o3: "-", pm10: "-" };
    };

    // -------------------------------------------------------
    // HELPER: คำนวณ Status และ AQI
    // -------------------------------------------------------
    const getAQIStatus = (aqi) => {
        aqi = parseFloat(aqi);
        if (aqi <= 25) return "คุณภาพดีมาก";
        if (aqi <= 50) return "คุณภาพดี";
        if (aqi <= 100) return "ปานกลาง";
        if (aqi <= 200) return "เริ่มมีผลกระทบ";
        return "มีผลกระทบต่อสุขภาพ";
    };

    const calAQI = (pm25) => {
        if(pm25 === "-" || isNaN(pm25)) return "-";
        return Math.round(pm25 * 4.4);
    }

    // -------------------------------------------------------
    // FUNCTION 4: ดึง Google Sheet
    // -------------------------------------------------------
    const getSheetData = async () => {
        try {
            const res = await fetch(SHEET_CSV_URL + '&t=' + new Date().getTime());
            const text = await res.text();
            const rows = text.split(/\r?\n/).filter(row => row.trim() !== "");
            
            if (rows.length > 1) {
                const lastRowStr = rows[rows.length - 1];
                const matches = lastRowStr.match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g);
                
                if (matches) {
                     const cols = matches.map(c => c.replace(/^"|"$/g, '').trim());
                     if(cols.length >= 3) {
                        return { timestamp: cols[0], type: cols[1], title: cols[2], fileUrl: cols[3] || '#' };
                     }
                } else {
                    const simpleCols = lastRowStr.split(',');
                    if(simpleCols.length >= 3) return { timestamp: simpleCols[0], type: simpleCols[1], title: simpleCols[2], fileUrl: simpleCols[3] || '#' };
                }
            }
        } catch (e) { console.error("Sheet Error:", e.message); }
        return null;
    };

    // -------------------------------------------------------
    // MAIN PROCESS
    // -------------------------------------------------------
    try {
        // 1. เรียกทุก API พร้อมกัน
        const [bkkData, air4ThaiData, meteoData, postData] = await Promise.all([
            getAirBKK(),
            getAir4Thai(),
            getOpenMeteo(),
            getSheetData()
        ]);

        // 2. รวมข้อมูล (Logic: AirBKK -> Air4Thai)
        let finalAir = {
            aqi: "-", pm25: "-", pm10: "-", o3: "-",
            status: "รอข้อมูล", time: "-", location: "เขตหลักสี่", source: "N/A"
        };

        // เลือกข้อมูลหลัก
        if (bkkData) {
            finalAir = { ...finalAir, ...bkkData };
        } else if (air4ThaiData) {
            finalAir = { ...finalAir, ...air4ThaiData };
        }

        // 3. เติมข้อมูลเสริม (Ozone/PM10) จาก OpenMeteo
        if (meteoData) {
            finalAir.o3 = meteoData.o3;
            if (finalAir.pm10 === "-" || finalAir.pm10 == 0 || finalAir.pm10 === undefined) {
                finalAir.pm10 = meteoData.pm10;
            }
        }

        // ส่งข้อมูลกลับ
        res.status(200).json({ air: finalAir, post: postData });

    } catch (criticalError) {
        res.status(500).json({ error: criticalError.message });
    }
};

