import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  WASocket,
} from "baileys";
import path from "path";
import { Boom } from "@hapi/boom";
import fs from "fs";
import type {
  MessageReceived,
  MessageUpdated,
  StartSessionParams,
  StartSessionWithPairingCodeParams,
} from "../Types";
import { CALLBACK_KEY, CREDENTIALS, Messages } from "../Defaults";
import {
  saveDocumentHandler,
  saveImageHandler,
  saveVideoHandler,
} from "../Utils/save-media";
import { WhatsappError } from "../Error";
import { parseMessageStatusCodeToReadable } from "../Utils/message-status";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { Agent } from 'https';

const sessions: Map<string, WASocket> = new Map();

const callback: Map<string, Function> = new Map();

const retryCount: Map<string, number> = new Map();

export const printState = (): void => {
  sessions.forEach((value, key) => {
    console.log(`Session ${key} is ${value === undefined ? 'undefined' : 'object'}`);
  });
  retryCount.forEach((_, key) => {
    console.log(`Retry count for session ${key} is ${retryCount.get(key)}`);
  });
}

const P = require("pino")({
  level: "silent",
});

export const startSession = async (
  sessionId = "mysession",
  options: StartSessionParams = { printQR: true },
  agent?: Agent
): Promise<WASocket> => {
  if (isSessionExistAndRunning(sessionId))
    throw new WhatsappError(Messages.sessionAlreadyExist(sessionId));

  const { version } = await fetchLatestBaileysVersion();
  const startSocket = async () => {
    const { state, saveCreds } = await useMultiFileAuthState(
      path.resolve(CREDENTIALS.DIR_NAME, sessionId + CREDENTIALS.PREFIX)
    );
    if(agent){
      console.log(`startSession using proxy agent: ${JSON.stringify(agent)}`)
    } else {
      console.log("startSession no proxy agent")
    }
    const sock: WASocket = makeWASocket({
      version,
      printQRInTerminal: options.printQR,
      auth: state,
      logger: P,
      markOnlineOnConnect: false,
      browser: Browsers.ubuntu("Chrome"),
      agent: agent
    });
    sessions.set(sessionId, { ...sock });
    try {
      sock.ev.process(async (events) => {
        if (events["connection.update"]) {
          const update = events["connection.update"];
          const { connection, lastDisconnect } = update;
          if (update.qr) {
            callback.get(CALLBACK_KEY.ON_QR)?.({
              sessionId,
              qr: update.qr,
            });
            options.onQRUpdated?.(update.qr);
          }
          if (connection == "connecting") {
            callback.get(CALLBACK_KEY.ON_CONNECTING)?.(sessionId);
            options.onConnecting?.();
          }
          if (connection === "close") {
            const code = (lastDisconnect?.error as Boom)?.output?.statusCode;
            let retryAttempt = retryCount.get(sessionId) ?? 0;
            let shouldRetry;
            if (code != DisconnectReason.loggedOut && retryAttempt < 10) {
              shouldRetry = true;
            } else {
              if (code != DisconnectReason.loggedOut) {
                console.log(`${sessionId} max retry attempts reached`);
              }
            }
            console.log(`session: ${sessionId} connection close code: ${code} retryAttempt: ${retryAttempt} shouldRetry: ${shouldRetry}`);
            if (shouldRetry) {
              retryAttempt++;
              retryCount.set(sessionId, retryAttempt);
              startSocket();
            } else {
              retryCount.delete(sessionId);
              deleteSession(sessionId);
              callback.get(CALLBACK_KEY.ON_DISCONNECTED)?.(sessionId);
              options.onDisconnected?.();
            }
          }
          if (connection == "open") {
            retryCount.delete(sessionId);
            callback.get(CALLBACK_KEY.ON_CONNECTED)?.(sessionId);
            options.onConnected?.();
          }
        }
        if (events["creds.update"]) {
          await saveCreds();
        }
        if (events["messages.update"]) {
          const msg = events["messages.update"][0];
          const data: MessageUpdated = {
            sessionId: sessionId,
            messageStatus: parseMessageStatusCodeToReadable(msg.update.status!),
            ...msg,
          };
          callback.get(CALLBACK_KEY.ON_MESSAGE_UPDATED)?.(data);
          options.onMessageUpdated?.(data);
        }
        if (events["messages.upsert"]) {
          const msg = events["messages.upsert"]
            .messages?.[0] as unknown as MessageReceived;
          msg.sessionId = sessionId;
          msg.saveImage = (path) => saveImageHandler(msg, path);
          msg.saveVideo = (path) => saveVideoHandler(msg, path);
          msg.saveDocument = (path) => saveDocumentHandler(msg, path);
          callback.get(CALLBACK_KEY.ON_MESSAGE_RECEIVED)?.({
            ...msg,
          });
          options.onMessageReceived?.(msg);
        }
      });
      return sock;
    } catch (error) {
      console.log("SOCKET ERROR", error);
      return sock;
    }
  };
  return startSocket();
};

/**
 *
 * @deprecated Use startSession method instead
 */
export const startSessionWithPairingCode = async (
  sessionId: string,
  options: StartSessionWithPairingCodeParams,
  agent?: Agent
): Promise<WASocket> => {
  if (isSessionExistAndRunning(sessionId))
    throw new WhatsappError(Messages.sessionAlreadyExist(sessionId));

  const { version } = await fetchLatestBaileysVersion();
  const startSocket = async () => {
    const { state, saveCreds } = await useMultiFileAuthState(
      path.resolve(CREDENTIALS.DIR_NAME, sessionId + CREDENTIALS.PREFIX)
    );
    if(agent){
      console.log(`startSessionWithPairingCode using proxy agent: ${JSON.stringify(agent)}`)
    } else {
      console.log("startSessionWithPairingCode no proxy agent")
    }
    const sock: WASocket = makeWASocket({
      version,
      printQRInTerminal: false,
      auth: state,
      logger: P,
      markOnlineOnConnect: false,
      browser: Browsers.ubuntu("Chrome"),
      agent: agent,
    });
    sessions.set(sessionId, { ...sock });
    try {
      if (!sock.authState.creds.registered) {
        console.log("first time pairing");
        const code = await sock.requestPairingCode(options.phoneNumber);
        console.log(code);
        callback.get(CALLBACK_KEY.ON_PAIRING_CODE)?.(sessionId, code);
      }

      sock.ev.process(async (events) => {
        if (events["connection.update"]) {
          const update = events["connection.update"];
          const { connection, lastDisconnect } = update;
          if (update.qr) {
            callback.get(CALLBACK_KEY.ON_QR)?.({
              sessionId,
              qr: update.qr,
            });
          }
          if (connection == "connecting") {
            callback.get(CALLBACK_KEY.ON_CONNECTING)?.(sessionId);
          }
          if (connection === "close") {
            const code = (lastDisconnect?.error as Boom)?.output?.statusCode;
            let retryAttempt = retryCount.get(sessionId) ?? 0;
            let shouldRetry;
            if (code != DisconnectReason.loggedOut && retryAttempt < 10) {
              shouldRetry = true;
            } else {
              if (code != DisconnectReason.loggedOut) {
                console.log(`${sessionId} max retry attempts reached`);
              }
            }
            if (shouldRetry) {
              retryAttempt++;
            }
            console.log(`session: ${sessionId} connection close code: ${code} retryAttempt: ${retryAttempt} shouldRetry: ${shouldRetry}`);
            if (shouldRetry) {
              retryCount.set(sessionId, retryAttempt);
              startSocket();
            } else {
              retryCount.delete(sessionId);
              deleteSession(sessionId);
              callback.get(CALLBACK_KEY.ON_DISCONNECTED)?.(sessionId);
            }
          }
          if (connection == "open") {
            retryCount.delete(sessionId);
            callback.get(CALLBACK_KEY.ON_CONNECTED)?.(sessionId);
          }
        }
        if (events["creds.update"]) {
          await saveCreds();
        }
        if (events["messages.update"]) {
          const msg = events["messages.update"][0];
          const data: MessageUpdated = {
            sessionId: sessionId,
            messageStatus: parseMessageStatusCodeToReadable(msg.update.status!),
            ...msg,
          };
          callback.get(CALLBACK_KEY.ON_MESSAGE_UPDATED)?.(data);
        }
        if (events["messages.upsert"]) {
          const msg = events["messages.upsert"]
            .messages?.[0] as unknown as MessageReceived;
          msg.sessionId = sessionId;
          msg.saveImage = (path) => saveImageHandler(msg, path);
          msg.saveVideo = (path) => saveVideoHandler(msg, path);
          msg.saveDocument = (path) => saveDocumentHandler(msg, path);
          callback.get(CALLBACK_KEY.ON_MESSAGE_RECEIVED)?.({
            ...msg,
          });
        }
      });
      return sock;
    } catch (error) {
      console.log("SOCKET ERROR", error);
      return sock;
    }
  };
  return startSocket();
};

/**
 * @deprecated Use startSession method instead
 */
export const startWhatsapp = startSession;

export const stopSession = async (sessionId: string) => {
  const session = getSession(sessionId);
  if (session) {
    session.end(undefined);
    sessions.delete(sessionId);
  } else {
    console.log(`stopSession: ${sessionId} not found`);
  }
}

export const listStoredSessions = () => {
  if (!fs.existsSync(path.resolve(CREDENTIALS.DIR_NAME))) {
    fs.mkdirSync(path.resolve(CREDENTIALS.DIR_NAME));
  }
  const numbers: string[] = [];
  fs.readdir(path.resolve(CREDENTIALS.DIR_NAME), async (err, dirs) => {
    if (err) {
      throw err;
    }

    for (const dir of dirs) {
      const sessionId = dir.split("_")[0];
      numbers.push(sessionId);
    }
   });
   return numbers;
}

export const deleteSession = async (sessionId: string) => {
  console.log(`deleteSession: ${sessionId}`);
  const session = getSession(sessionId);
  try {
    await session?.logout();
  } catch (error) {}
  session?.end(undefined);
  sessions.delete(sessionId);
  const dir = path.resolve(
    CREDENTIALS.DIR_NAME,
    sessionId + CREDENTIALS.PREFIX
  );
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
};
export const getAllSession = (): string[] => Array.from(sessions.keys());

export const getSession = (key: string): WASocket | undefined =>
  sessions.get(key) as WASocket;

const isSessionExistAndRunning = (sessionId: string): boolean => {
  if (
    fs.existsSync(path.resolve(CREDENTIALS.DIR_NAME)) &&
    fs.existsSync(
      path.resolve(CREDENTIALS.DIR_NAME, sessionId + CREDENTIALS.PREFIX)
    ) &&
    fs.readdirSync(
      path.resolve(CREDENTIALS.DIR_NAME, sessionId + CREDENTIALS.PREFIX)
    ).length &&
    getSession(sessionId)
  ) {
    return true;
  }
  return false;
};
const shouldLoadSession = (sessionId: string): boolean => {
  if (
    fs.existsSync(path.resolve(CREDENTIALS.DIR_NAME)) &&
    fs.existsSync(
      path.resolve(CREDENTIALS.DIR_NAME, sessionId + CREDENTIALS.PREFIX)
    ) &&
    fs.readdirSync(
      path.resolve(CREDENTIALS.DIR_NAME, sessionId + CREDENTIALS.PREFIX)
    ).length &&
    !getSession(sessionId)
  ) {
    return true;
  }
  return false;
};

export const loadSessionsFromStorage = (sessionIdToProxy: Record<string,string>) => {
  if (!fs.existsSync(path.resolve(CREDENTIALS.DIR_NAME))) {
    fs.mkdirSync(path.resolve(CREDENTIALS.DIR_NAME));
  }
  fs.readdir(path.resolve(CREDENTIALS.DIR_NAME), async (err, dirs) => {
    if (err) {
      throw err;
    }
    for (const dir of dirs) {
      const sessionId = dir.split("_")[0];
      if (!shouldLoadSession(sessionId)) continue;
      startSession(sessionId, {printQR: false}, new HttpsProxyAgent(sessionIdToProxy[sessionId]));
    }
  });
};

export const onMessageReceived = (listener: (msg: MessageReceived) => any) => {
  callback.set(CALLBACK_KEY.ON_MESSAGE_RECEIVED, listener);
};
export const onQRUpdated = (
  listener: ({ sessionId, qr }: { sessionId: string; qr: string }) => any
) => {
  callback.set(CALLBACK_KEY.ON_QR, listener);
};
export const onConnected = (listener: (sessionId: string) => any) => {
  callback.set(CALLBACK_KEY.ON_CONNECTED, listener);
};
export const onDisconnected = (listener: (sessionId: string) => any) => {
  callback.set(CALLBACK_KEY.ON_DISCONNECTED, listener);
};
export const onConnecting = (listener: (sessionId: string) => any) => {
  callback.set(CALLBACK_KEY.ON_CONNECTING, listener);
};

export const onMessageUpdate = (listener: (data: MessageUpdated) => any) => {
  callback.set(CALLBACK_KEY.ON_MESSAGE_UPDATED, listener);
};

export const onPairingCode = (
  listener: (sessionId: string, code: string) => any
) => {
  callback.set(CALLBACK_KEY.ON_MESSAGE_UPDATED, listener);
};
