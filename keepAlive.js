import axios from "axios";

const RENDER_URL = "https://cricket-livestream.onrender.com";

const MIN_INTERVAL = 12 * 60 * 1000; // 12 minutes
const MAX_INTERVAL = 14 * 60 * 1000; // 14 minutes

function isActiveTimeIST() {
  const now = new Date();
  const hoursIST = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
  ).getHours();

  return hoursIST >= 9 && hoursIST < 24; // 9 AM - 12 AM
}

function getRandomInterval() {
  return Math.floor(
    Math.random() * (MAX_INTERVAL - MIN_INTERVAL + 1) + MIN_INTERVAL
  );
}

async function runKeepAlive() {
  const timeNow = new Date().toLocaleTimeString("en-IN");

  if (!isActiveTimeIST()) {
    console.log(`⏸️ [${timeNow}] Sleeping (12 AM - 9 AM IST)`);
    scheduleNext();
    return;
  }

  console.log(`🚀 [${timeNow}] Keep-alive cron running`);

  try {
    await axios.get(`${RENDER_URL}/health`);
    console.log(`✅ [${timeNow}] Ping success`);
  } catch (err) {
    console.error(`❌ [${timeNow}] Ping failed:`, err.message);
  }

  scheduleNext();
}

function scheduleNext() {
  const interval = getRandomInterval();
  const nextRunTime = new Date(
    Date.now() + interval
  ).toLocaleTimeString("en-IN");

  console.log(
    `⏰ Next run scheduled in ${Math.round(interval / 60000)} minutes at ${nextRunTime}`
  );

  setTimeout(runKeepAlive, interval);
}

export function startKeepAlive() {
  console.log("🟢 Keep-alive cron job started");
  runKeepAlive(); // first run
}
