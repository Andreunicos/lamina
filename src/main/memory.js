'use strict';
// Liberação de memória e economia de CPU dos processos do app — tudo best-effort,
// só no Windows e SEM dependência nativa (node-gyp/ffi). A parte específica do
// Windows (EmptyWorkingSet e EcoQoS) é feita chamando o PowerShell, que compila
// um trechinho de C# em runtime (Add-Type) e faz P/Invoke das APIs do kernel32.
// Em qualquer outro sistema as funções não fazem nada.
const { app, session } = require('electron');
const { execFile } = require('child_process');

const isWin = process.platform === 'win32';

// PIDs de toda a árvore do app (main, GPU, rede, renderers das abas).
function allPids() {
  const pids = new Set([process.pid]);
  try {
    for (const m of app.getAppMetrics()) if (Number.isInteger(m.pid) && m.pid > 0) pids.add(m.pid);
  } catch {
    /* getAppMetrics indisponível */
  }
  return [...pids];
}

// Só os renderers das abas (type 'Tab'): é neles que roda o Chromium das webviews.
// Não inclui o main nem o GPU, que precisam ficar responsivos.
function tabPids() {
  try {
    return app
      .getAppMetrics()
      .filter((m) => m.type === 'Tab' && Number.isInteger(m.pid) && m.pid > 0)
      .map((m) => m.pid);
  } catch {
    return [];
  }
}

function runPowerShell(script) {
  if (!isWin) return;
  try {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 15000 },
      () => {
        /* best-effort: ignora qualquer erro */
      }
    );
  } catch {
    /* PowerShell ausente/bloqueado */
  }
}

// C# com as duas chamadas de kernel32 que usamos. Compilado em runtime pelo
// Add-Type; nenhuma DLL extra é distribuída com o app.
const CSHARP = `
using System;
using System.Runtime.InteropServices;
public static class LaminaNative {
  [StructLayout(LayoutKind.Sequential)]
  struct PPTS { public uint Version; public uint ControlMask; public uint StateMask; }
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint flags, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool K32EmptyWorkingSet(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool SetProcessInformation(IntPtr h, int cls, ref PPTS info, uint size);
  // PROCESS_QUERY_INFORMATION | PROCESS_SET_QUOTA
  const uint TRIM_ACCESS = 0x0400 | 0x0100;
  // PROCESS_SET_INFORMATION
  const uint ECO_ACCESS = 0x0200;
  const int ProcessPowerThrottling = 4;
  const uint EXECUTION_SPEED = 0x1;
  public static void Trim(int pid) {
    IntPtr h = OpenProcess(TRIM_ACCESS, false, (uint)pid);
    if (h == IntPtr.Zero) return;
    try { K32EmptyWorkingSet(h); } finally { CloseHandle(h); }
  }
  public static void Eco(int pid, bool on) {
    IntPtr h = OpenProcess(ECO_ACCESS, false, (uint)pid);
    if (h == IntPtr.Zero) return;
    try {
      PPTS s = new PPTS();
      s.Version = 1;
      s.ControlMask = EXECUTION_SPEED;
      s.StateMask = on ? EXECUTION_SPEED : 0u;
      SetProcessInformation(h, ProcessPowerThrottling, ref s, (uint)Marshal.SizeOf(s));
    } finally { CloseHandle(h); }
  }
}
`;

function psHeader() {
  return `$ErrorActionPreference='SilentlyContinue'\nAdd-Type @"\n${CSHARP}\n"@\n`;
}

// EmptyWorkingSet: devolve ao Windows a RAM física que os processos não estão
// usando no momento (o working set encolhe; se precisar de novo, a página volta).
// Reduz o "Memória em uso" que o usuário vê no Gerenciador de Tarefas.
function trimWorkingSets(pids) {
  const list = (pids || allPids()).filter((p) => Number.isInteger(p) && p > 0);
  if (!isWin || !list.length) return;
  const arr = list.join(',');
  runPowerShell(`${psHeader()}foreach ($p in @(${arr})) { try { [LaminaNative]::Trim([int]$p) } catch {} }`);
}

// EcoQoS (Efficiency Mode): marca os processos para rodarem nos núcleos de baixo
// consumo e em frequência reduzida. Ganho de energia/CPU, não de RAM. Usado nos
// renderers das abas quando a barra está recolhida (tudo em segundo plano).
function setEcoQoS(on, pids) {
  const list = (pids || tabPids()).filter((p) => Number.isInteger(p) && p > 0);
  if (!isWin || !list.length) return;
  const arr = list.join(',');
  const flag = on ? '$true' : '$false';
  runPowerShell(`${psHeader()}foreach ($p in @(${arr})) { try { [LaminaNative]::Eco([int]$p, ${flag}) } catch {} }`);
}

// "Liberar memória agora": limpa os caches HTTP de todas as sessões (sem deslogar),
// compacta o heap do main (se o GC estiver exposto) e encolhe o working set de todos
// os processos no Windows. Devolve a lista de partições limpas, para o log/relatório.
async function freeNow(partitions) {
  const parts = partitions || [];
  try {
    await session.defaultSession.clearCache();
  } catch {
    /* ocupada */
  }
  for (const p of parts) {
    try {
      await session.fromPartition(p).clearCache();
    } catch {
      /* ocupada */
    }
  }
  try {
    if (global.gc) {
      global.gc();
      global.gc();
    }
  } catch {
    /* GC não exposto no main */
  }
  trimWorkingSets();
  return { cleared: parts.length + 1 };
}

module.exports = { allPids, tabPids, trimWorkingSets, setEcoQoS, freeNow };
