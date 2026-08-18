// const fs = require("fs");
// const path = require("path");
// const { io } = require("socket.io-client");
// const ZKLib = require("./zktecho");

// const { default: axios } = require("axios");

// const socket = io("http://localhost:3000");

// socket.on("connect", () => console.log("socket connected:", socket.id));
// socket.on("disconnect", () => console.log("socket disconnected"));

// const devices = JSON.parse(fs.readFileSync(path.join(__dirname, "device.json"), "utf8"));

// const deviceState = {};
// const reconnecting = new Set();
// const zkInstances = {};
// const toKey = (name) => name.toLowerCase().replace(/-/g, "_");

// function emitDeviceStatus() {
//   socket.emit("device_status", { ...deviceState });
// }

// function scheduleReconnect(device) {
//   const key = toKey(device.name);
//   if (reconnecting.has(key)) return;
//   reconnecting.add(key);
//   setTimeout(() => {
//     reconnecting.delete(key);
//     connectDevice(device);
//   }, 5000);
// }

// async function connectDevice(device) {
//   const key = toKey(device.name);
//   reconnecting.add(key);
//   const zk = new ZKLib(device.ip, device.port, 1000, 4000);

//   const onClose = (type) => {
//     deviceState[key] = false;
//     delete zkInstances[key];
//     reconnecting.delete(key);
//     console.log(`[${device.name}] closed (${type})`);
//     emitDeviceStatus();
//     scheduleReconnect(device);
//   };

//   const onError = (err) => {
//     console.error(`[${device.name}] error:`, err.message);
//   };

//   try {
//     await zk.createSocket(onError, onClose);
//     deviceState[key] = true;
//     zkInstances[key] = zk;
//     reconnecting.delete(key);
//     console.log(`[${device.name}] connected via ${zk.connectionType}`);
//     emitDeviceStatus();

//     await zk.getRealTimeLogs((log) => {
//       console.log(`[${device.name}] realtime:`, log);
//       socket.emit("attendance_micro", {
//         deviceUserId: log.deviceUserId,
//         recordTime: log.recordTime,
//       });
//     });
//   } catch (err) {
//     deviceState[key] = false;
//     delete zkInstances[key];
//     reconnecting.delete(key);
//     console.error(`[${device.name}] failed:`, err.message);
//     emitDeviceStatus();
//     scheduleReconnect(device);
//   }
// }

// async function pingDevice(device) {
//   const key = toKey(device.name);
//   if (!deviceState[key] || reconnecting.has(key)) return;
//   const zk = zkInstances[key];
//   if (!zk) return;
//   try {
//     await zk.ping();
//   } catch (err) {
//     console.log(`[${device.name}] heartbeat failed — marking offline`);
//     deviceState[key] = false;
//     delete zkInstances[key];
//     emitDeviceStatus();
//     try { await zk.disconnect(); } catch (_) {}
//     scheduleReconnect(device);
//   }
// }

// async function getAttendance(device) {
//   const zk = new ZKLib(device.ip, device.port, 1000, 4000);

//   const onError = (err) => console.error(`[${device.name}] error:`, err.message);
//   const onClose = (type) => console.log(`[${device.name}] closed (${type})`);

//   try {
//     await zk.createSocket(onError, onClose);
//     const { data: logs, err } = await zk.getAttendances();
//     if (!err && logs.length) {
//       console.log(`[${device.name}] attendance_log count:`, logs.length);
//       socket.emit("attendance_log", {
//         device_state: { ...deviceState },
//         data: logs.map((r) => ({ deviceUserId: r.deviceUserId, recordTime: r.recordTime })),
//       });
//     }
//     await zk.disconnect();
//   } catch (err) {
//     console.error(`[${device.name}] getAttendance failed:`, err.message);
//   }
// }

// for (const device of devices) {
//   connectDevice(device);
//   // getAttendance(device);
// }

// // setInterval(()=>{
// //       socket.emit("attendance_micro", {
// //         deviceUserId:10011,
// //         recordTime: new Date().toISOString(),
// //       });
// // },5000)

// // Health check: ping connected devices, reconnect disconnected ones
// setInterval(() => {
//   for (const device of devicodataes) {
//     const key = toKey(device.name);
//     if (deviceState[key]) {
//       pingDevice(device);
//     } else if (!reconnecting.has(key)) {
//       console.log(`[${device.name}] health-check: not connected, reconnecting...`);
//       connectDevice(device);
//     }
//   }
// }, 30000);

const axios = require('axios');

const BASE_URL = 'https://mes.bandhabtex.com/Backend/odata';
const TOKEN =
  'Bearer 424|Y9FTFbycXkT5ZykbaNqUiOYPfDRwOQZN5FzEr40Gc1ba1aa2';

const headers = {
  Authorization: TOKEN,
  'Content-Type': 'application/json',
};

async function fetchAllEmployees() {
  const employeesById = new Map();
  let skip = 0;
  const top = 100;

  while (true) {
    const { data } = await axios.get(
      `${BASE_URL}/Employees?$top=${top}&$skip=${skip}`,
      { headers }
    );

    const records = data.value || [];
    if (records.length === 0) {
      break;
    }

    for (const employee of records) {
      const fullName = `${employee.first_name || ''} ${employee.last_name || ''}`.trim();
      employeesById.set(employee.id, fullName);
    }

    skip += records.length;
  }

  return employeesById;
}

const BANK_NAME = 'Dutch Bangla Bank';

async function syncEmployeeBankAccountHolderNames() {
  console.log('Starting employee bank info sync...');

  const employeesById = await fetchAllEmployees();
  console.log(`Loaded ${employeesById.size} employees`);

  let skip = 0;
  const top = 100;

  while (true) {
    const { data } = await axios.get(
      `${BASE_URL}/EmployeeBankInfos?$top=${top}&$skip=${skip}`,
      { headers }
    );

    const records = data.value || [];
    console.log(`Fetched ${records.length} bank info records (skip: ${skip})`);

    if (records.length === 0) {
      break;
    }

    for (const bankInfo of records) {
      try {
        const employeeName = employeesById.get(bankInfo.employee_id);

        if (!employeeName) {
          console.log(`BankInfo ${bankInfo.id}: No employee found for employee_id ${bankInfo.employee_id}`);
          continue;
        }

        if (bankInfo.account_holder_name === employeeName && bankInfo.bank_name === BANK_NAME) {
          console.log(`BankInfo ${bankInfo.id}: Already synced`);
          continue;
        }

        await axios.patch(
          `${BASE_URL}/EmployeeBankInfos(${bankInfo.id})`,
          { account_holder_name: employeeName, bank_name: BANK_NAME },
          { headers }
        );

        console.log(`BankInfo ${bankInfo.id}: Updated account_holder_name -> ${employeeName}, bank_name -> ${BANK_NAME}`);
      } catch (err) {
        console.error(
          `BankInfo ${bankInfo.id}: Failed`,
          err.response?.data || err.message
        );
      }
    }

    skip += records.length;
  }

  console.log('Employee bank info sync completed.');
}

syncEmployeeBankAccountHolderNames().catch((err) => {
  console.error('Sync failed:', err.response?.data || err.message);
});
