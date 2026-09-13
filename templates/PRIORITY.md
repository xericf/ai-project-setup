# Wave dispatch priority

Edited by the creator; read by `agent-wave` into each wave prompt. List the current critical
path in plain prose. Any packet named on a line containing the word "frozen" is treated as
frozen by `agent-admin`, which then refuses a Now block that names it as the next packet.

1. <First chain of packets on the critical path, in order.>
2. <Second chain.>
3. <Assembly or acceptance packet that the chains unlock.>
4. <Packet> is frozen at its integrated state. Reopen it only for a reviewer-confirmed defect.
5. Leases marked "drop" in the Now block are released, not resumed.
