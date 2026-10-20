#!/usr/bin/env python3
"""Install (compile + OTA) one ESPHome config via the ESPHome Device Builder add-on, from inside HA core.
Called by shell_command.hex_ota_install. Uses SUPERVISOR_TOKEN (present in HA core's env); no stored secrets.
Waits for any running dashboard job first (never interrupts one). '--status hex-NN.yaml' prints none/running/ok/failed (HA polls it). Install runs detached (shell_command 60 s limit); log /config/hex_ota.log."""
import asyncio, json, os, sys, aiohttp
CFG = sys.argv[1]
INGRESS = "ZQAPnJKAPVvbTTpMWUSU5Hf5sxhqz3AZopnTcLesWl8"   # ESPHome Device Builder ingress entry
async def main():
    tok = os.environ["SUPERVISOR_TOKEN"]
    async with aiohttp.ClientSession() as s:
        async with s.post("http://supervisor/ingress/session", headers={"Authorization": "Bearer " + tok}, json={"user_id": "510285031c3b4c189254da53e5873c12"}) as r:  # HA user (Terry) the session belongs to
            j = await r.json()
            if "data" not in j: print("session refused", r.status, j); return 8
            sess = j["data"]["session"]
        url = f"http://supervisor/ingress/{INGRESS}/ws"
        hdr = {"Cookie": "ingress_session=" + sess, "Authorization": "Bearer " + tok}
        async with s.ws_connect(url, headers=hdr, max_msg_size=0, heartbeat=20) as w:
            async def cmd(c, a, mid):
                await w.send_json({"command": c, "message_id": mid, "args": a})
                while True:
                    m = json.loads((await w.receive(timeout=60)).data)
                    if m.get("message_id") == mid: return m
            if CFG == "--status":
                jobs = (await cmd("firmware/get_jobs", {}, "j")).get("result") or []
                mine = [j for j in jobs if j["configuration"] == sys.argv[2]][:2]
                if not mine: print("none")
                elif any(j["status"] in ("running", "queued", "pending") for j in mine): print("running")
                else: print("ok" if all(j["status"] == "completed" and j.get("exit_code") == 0 for j in mine) else "failed")
                return 0
            if CFG == "--check":
                print(json.dumps((await cmd("firmware/get_jobs", {}, "j"))["result"][:2])[:300]); return 0
            for _ in range(60):   # wait up to ~30 min for other jobs
                jobs = (await cmd("firmware/get_jobs", {}, "j")).get("result") or []
                if not any(j["status"] in ("running", "queued", "pending") for j in jobs): break
                await asyncio.sleep(30)
            else:
                print("busy"); return 3
            r = await cmd("firmware/install", {"configuration": CFG, "port": "OTA", "force_local": False, "bootloader": False}, "i")
            jid = (r.get("result") or {}).get("job_id")
            if not jid: print("install refused", json.dumps(r)[:200]); return 4
        # follow every job for this config until compile+upload are done
        for _ in range(120):
            await asyncio.sleep(15)
            async with s.ws_connect(url, headers=hdr, max_msg_size=0) as w:
                await w.send_json({"command": "firmware/get_jobs", "message_id": "j", "args": {}})
                while True:
                    m = json.loads((await w.receive(timeout=60)).data)
                    if m.get("message_id") == "j": break
            mine = [j for j in m["result"] if j["configuration"] == CFG][:2]
            if mine and all(j["status"] not in ("running", "queued", "pending") for j in mine):
                ok = all(j["status"] == "completed" and j.get("exit_code") == 0 for j in mine)
                print("ok" if ok else "failed", [(j["job_type"], j["status"], j.get("exit_code")) for j in mine])
                return 0 if ok else 5
        print("timeout"); return 6
if CFG in ("--check", "--status"): sys.exit(asyncio.run(main()))
# shell_command has a hard 60 s timeout: detach, then report back with the hex_ota_result event.
if os.fork() > 0: sys.exit(0)
os.setsid()
fd = os.open('/config/hex_ota.log', os.O_WRONLY | os.O_CREAT | os.O_APPEND); os.dup2(fd, 1); os.dup2(fd, 2)
null = os.open(os.devnull, os.O_RDONLY); os.dup2(null, 0)
if os.fork() > 0: os._exit(0)
try: rc = asyncio.run(main())
except Exception as e: print("error", e); rc = 7
print(CFG, 'rc', rc, flush=True); os._exit(0)
