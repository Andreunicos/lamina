'use strict';
// Uso de CPU, memória e GPU, sem dependências nativas.
// GPU e temperatura: via nvidia-smi quando há placa NVIDIA; senão, só o nome da placa.
const os = require('os');
const { execFile } = require('child_process');

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const t of Object.values(cpu.times)) total += t;
    idle += cpu.times.idle;
  }
  return { idle, total };
}
let prev = cpuTimes();
function cpuPercent() {
  const now = cpuTimes();
  const idle = now.idle - prev.idle;
  const total = now.total - prev.total;
  prev = now;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(100 * (1 - idle / total))));
}

let nvidia = null; // null = ainda não sei, true, false
let gpuName = null;

function run(cmd, args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout }, (err, out) => resolve(err ? null : String(out || '')));
  });
}

async function nvidiaQuery() {
  const out = await run('nvidia-smi', [
    '--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total',
    '--format=csv,noheader,nounits',
  ]);
  if (!out) return null;
  const p = out.trim().split('\n')[0].split(',').map((s) => s.trim());
  if (p.length < 5) return null;
  return {
    name: p[0],
    percent: Number(p[1]) || 0,
    tempC: Number(p[2]) || null,
    vramUsedMB: Number(p[3]) || 0,
    vramTotalMB: Number(p[4]) || 0,
  };
}

async function read() {
  const total = os.totalmem();
  const free = os.freemem();
  const mem = {
    usedGB: +((total - free) / 1073741824).toFixed(1),
    totalGB: +(total / 1073741824).toFixed(1),
    percent: Math.round(100 * (1 - free / total)),
  };
  const cpu = { percent: cpuPercent(), cores: os.cpus().length };

  let gpu = null;
  if (process.platform === 'win32') {
    if (nvidia !== false) {
      const g = await nvidiaQuery();
      if (g) {
        nvidia = true;
        gpu = g;
      } else {
        nvidia = false;
      }
    }
    if (!gpu) {
      if (gpuName === null) {
        const out = await run('powershell', [
          '-NoProfile',
          '-Command',
          '(Get-CimInstance Win32_VideoController | Select-Object -First 1 -ExpandProperty Name)',
        ], 6000);
        gpuName = out ? out.trim().split('\n')[0].trim() || '' : '';
      }
      if (gpuName) gpu = { name: gpuName, percent: null, tempC: null, vramUsedMB: 0, vramTotalMB: 0 };
    }
  }
  return { cpu, mem, gpu };
}

module.exports = { read };
