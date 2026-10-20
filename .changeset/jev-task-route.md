---
"@curatejs/core": minor
---

`pick` and `curate` gain an optional `route: 'jev'` that asks the task itself what kind of answer it needs instead of matching its words. The four route questions in `ROUTE_QUESTIONS` ask whether the task needs a count or a complete list across sessions, a date, a duration or an order, the user's stated tastes, or the latest value of something. They go through the decide port once per pick: in the same request as the task's kind labels when the label gate asks them, alone otherwise. An answer at `LABEL_LANE_BAR` or more switches on the curator options its route maps to through `ROUTE_OPTIONS`: `taste` switches on `preferenceAdvice` and `preferenceChange`, and `count`, `date` and `latest` switch on `working`. `record.route` keeps the answers and the options they switched on.

`curate`'s own `route: 'jev'` applies `record.route.on`, so it must run on a pick made with `route: 'jev'`. It cannot combine with `routeByTask`, and explicit `working`, `preferenceAdvice` and `preferenceChange` values override the route's choices. Both routers are off by default: with `route` unset the output is identical to a pick and curate without it.
