---
"sarah-computer-controller": patch
---

Detect half-open connections via heartbeat acknowledgement. The controller pushed Phoenix heartbeats but never checked the replies, so when a Cloud Run instance drained without a clean socket close the process hung alive as a zombie — the machine showed offline while its supervisor saw a running process and never relaunched it. An unanswered heartbeat now finishes the connection so the process exits and its supervisor reconnects to the live instance.
