// mem_dump.js — 通用内存 dump: 把进程的 rw-(堆/数据) + r-x(代码字符串) 内存按页写到设备文件。
// 供 dump_mem_regex.py 拉回 PC 后按 hae_jskey_rules.json 正则匹配敏感信息(新JS/API/key)。
// 复用 sample_fulldump.js 的分页读法; 去掉了针对 MAC_KEY 的签名 hook(纯 dump)。
'use strict';
var FN = null;
var CAP = 0x30000000;   // 768MB 上限(覆盖 app 全内存)
function dump(){
  if (FN) return; FN = true;
  try{
    var fns = Process.enumerateRanges('r--');
    console.log('[MD] readable ranges=' + fns.length);
    var out = new File('/data/data/com.example.app/files/memdump.bin','wb');
    var total=0, nrange=0;
    fns.forEach(function(r){
      if (total >= CAP) return;
      if (r.size < 64 || r.size > 0x10000000) return;   // 64B..256MB
      nrange++;
      var off = 0;
      while (off < r.size && total < CAP){
        var chunk = Math.min(65536, r.size - off);
        try{
          var u = new Uint8Array(Memory.readByteArray(r.base.add(off), chunk));
          out.write(u); total += chunk; off += chunk;
        }catch(e){ off += 65536; }
      }
    });
    out.flush(); out.close();
    console.log('[MD] DONE ranges=' + nrange + ' total=' + total);
  }catch(e){ console.log('[MD] err ' + e); }
}
setTimeout(dump, 8000);        // attach 后等 app 稳定再 dump
setTimeout(dump, 20000);       // 兜底再 dump(若 8s 时 VM 未就绪)
console.log('[MD] mem_dump armed (rw-/r-x -> memdump.bin)');
