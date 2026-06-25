const net = require("net");
const dgram = require("dgram");

const COMMANDS = {
  CMD_CONNECT: 1000,
  CMD_EXIT: 1001,
  CMD_PREPARE_DATA: 1500,
  CMD_DATA: 1501,
  CMD_FREE_DATA: 1502,
  CMD_DATA_WRRQ: 1503,
  CMD_DATA_RDY: 1504,
  CMD_ATTLOG_RRQ: 13,
  CMD_REG_EVENT: 500,
  CMD_ACK_OK: 2000,
  CMD_ACK_DATA: 2002,
  CMD_GET_FREE_SIZES: 50,
  EF_ATTLOG: 1,
};

const USHRT_MAX = 65535;
const MAX_CHUNK = 65472;

const REQUEST_DATA = {
  GET_REAL_TIME_EVENT: Buffer.from([0x01, 0x00, 0x00, 0x00]),
  GET_ATTENDANCE_LOGS: Buffer.from([0x01, 0x0d, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
  GET_USERS: Buffer.from([0x01, 0x09, 0x00, 0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
};

function parseTimeToDate(time) {
  const second = time % 60;
  time = (time - second) / 60;
  const minute = time % 60;
  time = (time - minute) / 60;
  const hour = time % 24;
  time = (time - hour) / 24;
  const day = (time % 31) + 1;
  time = (time - (day - 1)) / 31;
  const month = time % 12;
  time = (time - month) / 12;
  const year = time + 2000;
  return new Date(year, month, day, hour, minute, second);
}

function parseHexToTime(hex) {
  const year = hex.readUIntLE(0, 1);
  const month = hex.readUIntLE(1, 1);
  const date = hex.readUIntLE(2, 1);
  const hour = hex.readUIntLE(3, 1);
  const minute = hex.readUIntLE(4, 1);
  const second = hex.readUIntLE(5, 1);
  return new Date(2000 + year, month - 1, date, hour, minute, second);
}

function createChkSum(buf) {
  let chksum = 0;
  for (let i = 0; i < buf.length; i += 2) {
    if (i === buf.length - 1) chksum += buf[i];
    else chksum += buf.readUInt16LE(i);
    chksum %= USHRT_MAX;
  }
  return USHRT_MAX - chksum - 1;
}

function createUDPHeader(command, sessionId, replyId, data) {
  const dataBuffer = Buffer.from(data);
  const buf = Buffer.alloc(8 + dataBuffer.length);
  buf.writeUInt16LE(command, 0);
  buf.writeUInt16LE(0, 2);
  buf.writeUInt16LE(sessionId, 4);
  buf.writeUInt16LE(replyId, 6);
  dataBuffer.copy(buf, 8);
  buf.writeUInt16LE(createChkSum(buf), 2);
  buf.writeUInt16LE((replyId + 1) % USHRT_MAX, 6);
  return buf;
}

function createTCPHeader(command, sessionId, replyId, data) {
  const dataBuffer = Buffer.from(data);
  const buf = Buffer.alloc(8 + dataBuffer.length);
  buf.writeUInt16LE(command, 0);
  buf.writeUInt16LE(0, 2);
  buf.writeUInt16LE(sessionId, 4);
  buf.writeUInt16LE(replyId, 6);
  dataBuffer.copy(buf, 8);
  buf.writeUInt16LE(createChkSum(buf), 2);
  buf.writeUInt16LE((replyId + 1) % USHRT_MAX, 6);
  const prefixBuf = Buffer.from([0x50, 0x50, 0x82, 0x7d, 0x13, 0x00, 0x00, 0x00]);
  prefixBuf.writeUInt16LE(buf.length, 4);
  return Buffer.concat([prefixBuf, buf]);
}

function removeTcpHeader(buf) {
  if (buf.length < 8) return buf;
  if (buf.compare(Buffer.from([0x50, 0x50, 0x82, 0x7d]), 0, 4, 0, 4) !== 0) return buf;
  return buf.slice(8);
}

function decodeUserData72(userData) {
  return {
    uid: userData.readUIntLE(0, 2),
    role: userData.readUIntLE(2, 1),
    name: userData.slice(11).toString("ascii").split("\0").shift(),
    userId: userData.slice(48, 57).toString("ascii").split("\0").shift(),
  };
}

function decodeUserData28(userData) {
  return {
    uid: userData.readUIntLE(0, 2),
    role: userData.readUIntLE(2, 1),
    name: userData.slice(8, 16).toString("ascii").split("\0").shift(),
    userId: userData.readUIntLE(24, 4),
  };
}

function decodeRecordData40(recordData) {
  return {
    userSn: recordData.readUIntLE(0, 2),
    deviceUserId: recordData.slice(2, 11).toString("ascii").split("\0").shift(),
    recordTime: parseTimeToDate(recordData.readUInt32LE(27)),
  };
}

function decodeRecordData16(recordData) {
  return {
    deviceUserId: String(recordData.readUIntLE(0, 2)),
    recordTime: parseTimeToDate(recordData.readUInt32LE(4)),
  };
}

function decodeRecordRealTimeLog52(recordData) {
  const payload = removeTcpHeader(recordData);
  const recvData = payload.subarray(8);
  const deviceUserId = recvData.slice(0, 9).toString("ascii").split("\0").shift();
  const recordTime = parseHexToTime(recvData.subarray(26, 32));
  return { deviceUserId, recordTime, userId: deviceUserId, attTime: recordTime };
}

function decodeRecordRealTimeLog18(recordData) {
  const deviceUserId = String(recordData.readUIntLE(8, 1));
  const recordTime = parseHexToTime(recordData.subarray(12, 18));
  return { deviceUserId, recordTime, userId: deviceUserId, attTime: recordTime };
}

function decodeUDPHeader(header) {
  return {
    commandId: header.readUIntLE(0, 2),
    sessionId: header.readUIntLE(4, 2),
    replyId: header.readUIntLE(6, 2),
  };
}

function decodeTCPHeader(header) {
  const recvData = header.subarray(8);
  return {
    commandId: recvData.readUIntLE(0, 2),
    sessionId: recvData.readUIntLE(4, 2),
    replyId: recvData.readUIntLE(6, 2),
  };
}

function checkNotEventTCP(data) {
  try {
    data = removeTcpHeader(data);
    return data.readUIntLE(0, 2) === COMMANDS.CMD_REG_EVENT && data.readUIntLE(4, 2) === COMMANDS.EF_ATTLOG;
  } catch {
    return false;
  }
}

function checkNotEventUDP(data) {
  return decodeUDPHeader(data.subarray(0, 8)).commandId === COMMANDS.CMD_REG_EVENT;
}

class ZKLibTCP {
  constructor(ip, port, timeout) {
    this.ip = ip;
    this.port = port;
    this.timeout = timeout;
    this.sessionId = null;
    this.replyId = 0;
    this.socket = null;
    this.realtimeHandler = null;
  }

  createSocket(cbError, cbClose) {
    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();
      this.socket.once("error", (err) => { reject(err); cbError && cbError(err); });
      this.socket.once("connect", () => resolve(this.socket));
      this.socket.once("close", () => { this.socket = null; cbClose && cbClose("tcp"); });
      if (this.timeout) this.socket.setTimeout(this.timeout);
      this.socket.connect(this.port, this.ip);
    });
  }

  connect() {
    return this.executeCmd(COMMANDS.CMD_CONNECT, "").then((reply) => !!reply);
  }

  closeSocket() {
    return new Promise((resolve) => {
      if (!this.socket) return resolve(true);
      this.socket.removeAllListeners("data");
      this.socket.end(() => resolve(true));
      setTimeout(() => resolve(true), 2000);
    });
  }

  writeMessage(msg, connect) {
    return new Promise((resolve, reject) => {
      let timer = null;
      this.socket.once("data", (data) => { if (timer) clearTimeout(timer); resolve(data); });
      this.socket.write(msg, null, (err) => {
        if (err) return reject(err);
        if (this.timeout) {
          timer = setTimeout(() => reject(new Error("TIMEOUT_ON_WRITING_MESSAGE")), connect ? 2000 : this.timeout);
        }
      });
    });
  }

  requestData(msg) {
    return new Promise((resolve, reject) => {
      let timer = null;
      let replyBuffer = Buffer.from([]);

      const internalCallback = (data) => {
        this.socket.removeListener("data", handleOnData);
        if (timer) clearTimeout(timer);
        resolve(data);
      };

      const handleOnData = (data) => {
        replyBuffer = Buffer.concat([replyBuffer, data]);
        if (checkNotEventTCP(data)) return;
        if (timer) clearTimeout(timer);
        const header = decodeTCPHeader(replyBuffer.subarray(0, 16));
        if (header.commandId === COMMANDS.CMD_DATA) {
          timer = setTimeout(() => internalCallback(replyBuffer), 1000);
          return;
        }
        timer = setTimeout(() => reject(new Error("TIMEOUT_ON_RECEIVING_REQUEST_DATA")), this.timeout);
        const packetLength = data.readUIntLE(4, 2);
        if (packetLength > 8) internalCallback(data);
      };

      this.socket.on("data", handleOnData);
      this.socket.write(msg, null, (err) => {
        if (err) return reject(err);
        timer = setTimeout(() => reject(Error("TIMEOUT_IN_RECEIVING_RESPONSE_AFTER_REQUESTING_DATA")), this.timeout);
      });
    });
  }

  executeCmd(command, data = "") {
    return new Promise(async (resolve, reject) => {
      try {
        if (command === COMMANDS.CMD_CONNECT) { this.sessionId = 0; this.replyId = 0; }
        else { this.replyId++; }
        const buf = createTCPHeader(command, this.sessionId, this.replyId, data);
        const reply = await this.writeMessage(buf, command === COMMANDS.CMD_CONNECT || command === COMMANDS.CMD_EXIT);
        const rReply = removeTcpHeader(reply);
        if (command === COMMANDS.CMD_CONNECT) this.sessionId = rReply.readUInt16LE(4);
        resolve(rReply);
      } catch (err) { reject(err); }
    });
  }

  sendChunkRequest(start, size) {
    this.replyId++;
    const reqData = Buffer.alloc(8);
    reqData.writeUInt32LE(start, 0);
    reqData.writeUInt32LE(size, 4);
    const buf = createTCPHeader(COMMANDS.CMD_DATA_RDY, this.sessionId, this.replyId, reqData);
    this.socket.write(buf, null, () => {});
  }

  readWithBuffer(reqData, cb = null) {
    return new Promise(async (resolve, reject) => {
      this.replyId++;
      const buf = createTCPHeader(COMMANDS.CMD_DATA_WRRQ, this.sessionId, this.replyId, reqData);
      let reply = null;
      try { reply = await this.requestData(buf); } catch (err) { return reject(err); }

      const header = decodeTCPHeader(reply.subarray(0, 16));
      switch (header.commandId) {
        case COMMANDS.CMD_DATA:
          resolve({ data: reply.subarray(16), mode: 8, err: null });
          break;
        case COMMANDS.CMD_ACK_OK:
        case COMMANDS.CMD_PREPARE_DATA: {
          const recvData = reply.subarray(16);
          const size = recvData.readUIntLE(1, 4);
          const remain = size % MAX_CHUNK;
          const numberChunks = Math.round(size - remain) / MAX_CHUNK;
          let totalPackets = numberChunks + (remain > 0 ? 1 : 0);
          let replyData = Buffer.from([]);
          let totalBuffer = Buffer.from([]);
          let realTotalBuffer = Buffer.from([]);
          const timeout = 10000;

          const internalCallback = (replyData, err = null) => {
            if (timer) clearTimeout(timer);
            resolve({ data: replyData, err });
          };

          let timer = setTimeout(() => internalCallback(replyData, new Error("TIMEOUT WHEN RECEIVING PACKET")), timeout);

          const handleOnData = (chunk) => {
            if (checkNotEventTCP(chunk)) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => internalCallback(replyData, new Error(`TIME OUT !! ${totalPackets} PACKETS REMAIN !`)), timeout);
            totalBuffer = Buffer.concat([totalBuffer, chunk]);
            const packetLength = totalBuffer.readUIntLE(4, 2);
            if (totalBuffer.length >= 8 + packetLength) {
              realTotalBuffer = Buffer.concat([realTotalBuffer, totalBuffer.subarray(16, 8 + packetLength)]);
              totalBuffer = totalBuffer.subarray(8 + packetLength);
              if ((totalPackets > 1 && realTotalBuffer.length === MAX_CHUNK + 8) ||
                  (totalPackets === 1 && realTotalBuffer.length === remain + 8)) {
                replyData = Buffer.concat([replyData, realTotalBuffer.subarray(8)]);
                totalBuffer = Buffer.from([]);
                realTotalBuffer = Buffer.from([]);
                totalPackets -= 1;
                cb && cb(replyData.length, size);
                if (totalPackets <= 0) internalCallback(replyData);
              }
            }
          };

          this.socket.once("close", () => internalCallback(replyData, new Error("Socket is disconnected unexpectedly")));
          this.socket.on("data", handleOnData);
          for (let i = 0; i <= numberChunks; i++) {
            if (i === numberChunks) this.sendChunkRequest(numberChunks * MAX_CHUNK, remain);
            else this.sendChunkRequest(i * MAX_CHUNK, MAX_CHUNK);
          }
          break;
        }
        default:
          reject(new Error("ERROR_IN_UNHANDLE_CMD"));
      }
    });
  }

  async getUsers() {
    if (this.socket) await this.freeData().catch((err) => Promise.reject(err));
    const data = await this.readWithBuffer(REQUEST_DATA.GET_USERS);
    if (this.socket) await this.freeData().catch((err) => Promise.reject(err));
    let userData = data.data.subarray(4);
    const users = [];
    while (userData.length >= 72) {
      users.push(decodeUserData72(userData.subarray(0, 72)));
      userData = userData.subarray(72);
    }
    return { data: users, err: data.err };
  }

  async getAttendances(cb = () => {}) {
    if (this.socket) await this.freeData().catch((err) => Promise.reject(err));
    const data = await this.readWithBuffer(REQUEST_DATA.GET_ATTENDANCE_LOGS, cb);
    if (this.socket) await this.freeData().catch((err) => Promise.reject(err));
    let recordData = data.data.subarray(4);
    const records = [];
    while (recordData.length >= 40) {
      records.push({ ...decodeRecordData40(recordData.subarray(0, 40)), ip: this.ip });
      recordData = recordData.subarray(40);
    }
    return { data: records, err: data.err };
  }

  async freeData() {
    return this.executeCmd(COMMANDS.CMD_FREE_DATA, "");
  }

  async disconnect() {
    try { await this.executeCmd(COMMANDS.CMD_EXIT, ""); } catch {}
    return this.closeSocket();
  }

  async getRealTimeLogs(cb = () => {}) {
    this.replyId++;
    const buf = createTCPHeader(COMMANDS.CMD_REG_EVENT, this.sessionId, this.replyId, Buffer.from([0x01, 0x00, 0x00, 0x00]));
    this.socket.write(buf, null, () => {});
    if (this.realtimeHandler) this.socket.removeListener("data", this.realtimeHandler);
    this.realtimeHandler = (data) => {
      if (!checkNotEventTCP(data)) return;
      if (data.length > 16) cb(decodeRecordRealTimeLog52(data));
    };
    this.socket.on("data", this.realtimeHandler);
  }
}

class ZKLibUDP {
  constructor(ip, port, timeout, inport) {
    this.ip = ip;
    this.port = port;
    this.timeout = timeout;
    this.inport = inport;
    this.sessionId = null;
    this.replyId = 0;
    this.socket = null;
    this.realtimeHandler = null;
  }

  createSocket(cbError, cbClose) {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket("udp4");
      this.socket.once("error", (err) => { reject(err); cbError && cbError(err); });
      this.socket.on("close", () => { this.socket = null; cbClose && cbClose("udp"); });
      this.socket.once("listening", () => resolve(this.socket));
      this.socket.bind(this.inport);
    });
  }

  connect() {
    return this.executeCmd(COMMANDS.CMD_CONNECT, "").then((reply) => !!reply);
  }

  closeSocket() {
    return new Promise((resolve) => {
      if (!this.socket) return resolve(true);
      this.socket.removeAllListeners("message");
      this.socket.close(() => resolve(true));
      setTimeout(() => resolve(true), 2000);
    });
  }

  writeMessage(msg, connect) {
    return new Promise((resolve, reject) => {
      let timer = null;
      this.socket.once("message", (data) => { if (timer) clearTimeout(timer); resolve(data); });
      this.socket.send(msg, 0, msg.length, this.port, this.ip, (err) => {
        if (err) return reject(err);
        if (this.timeout) {
          timer = setTimeout(() => reject(new Error("TIMEOUT_ON_WRITING_MESSAGE")), connect ? 2000 : this.timeout);
        }
      });
    });
  }

  requestData(msg) {
    return new Promise((resolve, reject) => {
      let timer = null;
      let replyBuffer = Buffer.from([]);

      const internalCallback = (data) => {
        this.socket.removeListener("message", handleOnData);
        if (timer) clearTimeout(timer);
        resolve(data);
      };

      const handleOnData = (data) => {
        replyBuffer = Buffer.concat([replyBuffer, data]);
        if (checkNotEventUDP(data)) return;
        if (timer) clearTimeout(timer);
        const header = decodeUDPHeader(replyBuffer.subarray(0, 8));
        if (header.commandId === COMMANDS.CMD_DATA) {
          timer = setTimeout(() => internalCallback(replyBuffer), 1000);
          return;
        }
        timer = setTimeout(() => reject(new Error("TIMEOUT_ON_RECEIVING_REQUEST_DATA")), this.timeout);
        const packetLength = data.readUIntLE(4, 2);
        if (packetLength > 8) internalCallback(data);
      };

      this.socket.on("message", handleOnData);
      this.socket.send(msg, 0, msg.length, this.port, this.ip, (err) => {
        if (err) return reject(err);
        timer = setTimeout(() => reject(Error("TIMEOUT_IN_RECEIVING_RESPONSE_AFTER_REQUESTING_DATA")), this.timeout);
      });
    });
  }

  executeCmd(command, data = "") {
    return new Promise(async (resolve, reject) => {
      try {
        if (command === COMMANDS.CMD_CONNECT) { this.sessionId = 0; this.replyId = 0; }
        else { this.replyId++; }
        const buf = createUDPHeader(command, this.sessionId, this.replyId, data);
        const reply = await this.writeMessage(buf, command === COMMANDS.CMD_CONNECT || command === COMMANDS.CMD_EXIT);
        if (command === COMMANDS.CMD_CONNECT) this.sessionId = reply.readUInt16LE(4);
        resolve(reply);
      } catch (err) { reject(err); }
    });
  }

  sendChunkRequest(start, size) {
    this.replyId++;
    const reqData = Buffer.alloc(8);
    reqData.writeUInt32LE(start, 0);
    reqData.writeUInt32LE(size, 4);
    const buf = createUDPHeader(COMMANDS.CMD_DATA_RDY, this.sessionId, this.replyId, reqData);
    this.socket.send(buf, 0, buf.length, this.port, this.ip, () => {});
  }

  readWithBuffer(reqData, cb = null) {
    return new Promise(async (resolve, reject) => {
      this.replyId++;
      const buf = createUDPHeader(COMMANDS.CMD_DATA_WRRQ, this.sessionId, this.replyId, reqData);
      let reply = null;
      try { reply = await this.requestData(buf); } catch (err) { return reject(err); }

      const header = decodeUDPHeader(reply.subarray(0, 8));
      switch (header.commandId) {
        case COMMANDS.CMD_DATA:
          resolve({ data: reply.subarray(8), mode: 8, err: null });
          break;
        case COMMANDS.CMD_ACK_OK:
        case COMMANDS.CMD_PREPARE_DATA: {
          const recvData = reply.subarray(8);
          const size = recvData.readUIntLE(1, 4);
          const remain = size % MAX_CHUNK;
          const numberChunks = Math.round(size - remain) / MAX_CHUNK;
          let totalBuffer = Buffer.from([]);
          const timeout = 3000;

          const internalCallback = (replyData, err = null) => {
            if (timer) clearTimeout(timer);
            this.socket.removeListener("message", handleOnData);
            resolve({ data: replyData, err });
          };

          let timer = setTimeout(() => internalCallback(totalBuffer, new Error("TIMEOUT WHEN RECEIVING PACKET")), timeout);

          const handleOnData = (chunk) => {
            if (checkNotEventUDP(chunk)) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => internalCallback(totalBuffer, new Error(`TIMEOUT !! ${(size - totalBuffer.length) / size} % REMAIN !`)), timeout);
            const chunkHeader = decodeUDPHeader(chunk);
            switch (chunkHeader.commandId) {
              case COMMANDS.CMD_PREPARE_DATA: break;
              case COMMANDS.CMD_DATA:
                totalBuffer = Buffer.concat([totalBuffer, chunk.subarray(8)]);
                cb && cb(totalBuffer.length, size);
                break;
              case COMMANDS.CMD_ACK_OK:
                if (totalBuffer.length === size) internalCallback(totalBuffer);
                break;
              default:
                internalCallback([], new Error("ERROR_IN_UNHANDLE_CMD"));
            }
          };

          this.socket.on("message", handleOnData);
          for (let i = 0; i <= numberChunks; i++) {
            if (i === numberChunks) this.sendChunkRequest(numberChunks * MAX_CHUNK, remain);
            else this.sendChunkRequest(i * MAX_CHUNK, MAX_CHUNK);
          }
          break;
        }
        default:
          reject(new Error("ERROR_IN_UNHANDLE_CMD"));
      }
    });
  }

  async getUsers() {
    if (this.socket) await this.freeData().catch((err) => Promise.reject(err));
    const data = await this.readWithBuffer(REQUEST_DATA.GET_USERS);
    if (this.socket) await this.freeData().catch((err) => Promise.reject(err));
    let userData = data.data.subarray(4);
    const users = [];
    while (userData.length >= 28) {
      users.push(decodeUserData28(userData.subarray(0, 28)));
      userData = userData.subarray(28);
    }
    return { data: users, err: data.err };
  }

  async getAttendances(cb = () => {}) {
    if (this.socket) await this.freeData().catch((err) => Promise.reject(err));
    const data = await this.readWithBuffer(REQUEST_DATA.GET_ATTENDANCE_LOGS, cb);
    if (this.socket) await this.freeData().catch((err) => Promise.reject(err));
    let recordData = data.data.subarray(4);
    const records = [];
    while (recordData.length >= 16) {
      records.push({ ...decodeRecordData16(recordData.subarray(0, 16)), ip: this.ip });
      recordData = recordData.subarray(16);
    }
    return { data: records, err: data.err };
  }

  async freeData() {
    return this.executeCmd(COMMANDS.CMD_FREE_DATA, "");
  }

  async disconnect() {
    try { await this.executeCmd(COMMANDS.CMD_EXIT, ""); } catch {}
    return this.closeSocket();
  }

  async getRealTimeLogs(cb = () => {}) {
    this.replyId++;
    const buf = createUDPHeader(COMMANDS.CMD_REG_EVENT, this.sessionId, this.replyId, REQUEST_DATA.GET_REAL_TIME_EVENT);
    this.socket.send(buf, 0, buf.length, this.port, this.ip, () => {});
    if (this.realtimeHandler) this.socket.removeListener("message", this.realtimeHandler);
    this.realtimeHandler = (data) => {
      if (!checkNotEventUDP(data)) return;
      if (data.length === 18) cb(decodeRecordRealTimeLog18(data));
    };
    this.socket.on("message", this.realtimeHandler);
  }
}

class ZKLib {
  constructor(ip, port, timeout, inport) {
    this.connectionType = null;
    this.zklibTcp = new ZKLibTCP(ip, port, timeout);
    this.zklibUdp = new ZKLibUDP(ip, port, timeout, inport);
    this.ip = ip;
  }

  async functionWrapper(tcpCallback, udpCallback) {
    switch (this.connectionType) {
      case "tcp": return this.zklibTcp.socket ? tcpCallback() : Promise.reject(new Error("Socket isn't connected !"));
      case "udp": return this.zklibUdp.socket ? udpCallback() : Promise.reject(new Error("Socket isn't connected !"));
      default: return Promise.reject(new Error("Socket isn't connected !"));
    }
  }

  async createSocket(cbErr, cbClose) {
    try {
      if (!this.zklibTcp.socket) {
        await this.zklibTcp.createSocket(cbErr, cbClose);
        await this.zklibTcp.connect();
      }
      this.connectionType = "tcp";
    } catch (err) {
      try { await this.zklibTcp.disconnect(); } catch {}
      try {
        if (!this.zklibUdp.socket) {
          await this.zklibUdp.createSocket(cbErr, cbClose);
          await this.zklibUdp.connect();
        }
        this.connectionType = "udp";
      } catch (udpErr) {
        try { await this.zklibUdp.disconnect(); } catch {}
        this.connectionType = null;
        throw udpErr;
      }
    }
  }

  async getUsers() {
    return this.functionWrapper(() => this.zklibTcp.getUsers(), () => this.zklibUdp.getUsers());
  }

  async getAttendances(cb) { 
    return this.functionWrapper(() => this.zklibTcp.getAttendances(cb), () => this.zklibUdp.getAttendances(cb));
  }

  async getRealTimeLogs(cb) {
    return this.functionWrapper(() => this.zklibTcp.getRealTimeLogs(cb), () => this.zklibUdp.getRealTimeLogs(cb));
  }

  async disconnect() {
    return this.functionWrapper(() => this.zklibTcp.disconnect(), () => this.zklibUdp.disconnect());
  }
}

module.exports = ZKLib;
