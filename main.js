const fs = require("fs");
const path = require("path");
const { io } = require("socket.io-client");
const ZKLib = require("./zktecho");

const socket = io("http://localhost:3000");

socket.on("connect", () => console.log("socket connected:", socket.id));
socket.on("disconnect", () => console.log("socket disconnected"));

const devices = JSON.parse(fs.readFileSync(path.join(__dirname, "device.json"), "utf8"));

const deviceState = {};
const toKey = (name) => name.toLowerCase().replace(/-/g, "_");

function emitDeviceStatus() {
  socket.emit("device_status", { ...deviceState });
}

async function connectDevice(device) {
  const key = toKey(device.name);
  const zk = new ZKLib(device.ip, device.port, 1000, 4000);

  const onClose = (type) => {
    deviceState[key] = false;
    console.log(`[${device.name}] closed (${type})`);
    emitDeviceStatus();
    setTimeout(() => connectDevice(device), 5000);
  };

  const onError = (err) => {
    console.error(`[${device.name}] error:`, err.message);
  };

  try {
    await zk.createSocket(onError, onClose);
    deviceState[key] = true;
    console.log(`[${device.name}] connected via ${zk.connectionType}`);
    emitDeviceStatus();

    await zk.getRealTimeLogs((log) => {
      console.log(`[${device.name}] realtime:`, log);
      socket.emit("attendance_micro", {
        deviceUserId: log.deviceUserId,
        recordTime: log.recordTime,
      });
    });
  } catch (err) {
    deviceState[key] = false;
    console.error(`[${device.name}] failed:`, err.message);
    emitDeviceStatus();
    setTimeout(() => connectDevice(device), 5000);
  }
}

async function getAttendance(device) {
  const zk = new ZKLib(device.ip, device.port, 1000, 4000);

  const onError = (err) => console.error(`[${device.name}] error:`, err.message);
  const onClose = (type) => console.log(`[${device.name}] closed (${type})`);

  try {
    await zk.createSocket(onError, onClose);
    const { data: logs, err } = await zk.getAttendances();
    if (!err && logs.length) {
      console.log(`[${device.name}] attendance_log count:`, logs.length);
      socket.emit("attendance_log", {
        device_state: { ...deviceState },
        data: logs.map((r) => ({ deviceUserId: r.deviceUserId, recordTime: r.recordTime })),
      });
    }
    await zk.disconnect();
  } catch (err) {
    console.error(`[${device.name}] getAttendance failed:`, err.message);
  }
}

for (const device of devices) {
  connectDevice(device);
  // getAttendance(device);
}


// setInterval(()=>{
//       socket.emit("attendance_micro", {
//         deviceUserId:10220,
//         recordTime: new Date().toISOString(),
//       });
// },1000)