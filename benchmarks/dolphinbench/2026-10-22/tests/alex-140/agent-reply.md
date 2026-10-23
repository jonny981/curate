Updated `metrics-pipeline-2023-cutover-order` with the historical 2023 sequence:

ingest-edge → metrics-router → shard-keeper

It now documents that ingest-edge was first due to its lowest blast radius, and shard-keeper was last because of its complicated long-tail cardinality logic.
