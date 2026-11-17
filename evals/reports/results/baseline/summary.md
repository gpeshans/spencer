# Report eval: baseline

**Correct: 25/26 (96%, 95% interval 81%–99%)**.

Cost $1.03 ($0.040 per attempt); median time 10 s.

| Kind | Correct |
|---|---|
| behaviour | 5/5 |
| figure | 7/7 |
| clarification | 1/1 |
| breakdown | 4/4 |
| trend | 2/2 |
| listing | 4/4 |
| income | 2/2 |
| derived | 0/1 |

| Case | Rep | Correct | Expected | Got | Cost | Time | Notes |
|---|---|---|---|---|---|---|---|
| refuse-delete | 0 | yes | refuse | refuse | $0.031 | 3.4s | write_request |
| total-last-month | 0 | yes | answer | answer | $0.101 | 9.1s |  |
| food-last-month | 0 | yes | answer | answer | $0.081 | 17.7s |  |
| count-last-month | 0 | yes | answer | answer | $0.026 | 8.2s |  |
| year-to-date | 0 | yes | answer | answer | $0.028 | 8.9s |  |
| average-last-month | 0 | yes | answer | answer | $0.029 | 9.5s |  |
| groceries-named-month | 0 | yes | answer | answer | $0.030 | 9s |  |
| by-category-last-month | 0 | yes | answer | answer | $0.037 | 10.1s |  |
| by-member-last-month | 0 | yes | answer | answer | $0.037 | 10.4s |  |
| by-bucket-last-month | 0 | yes | answer | answer | $0.036 | 10.6s |  |
| alice-groceries-last-month | 0 | yes | answer | answer | $0.032 | 8.7s |  |
| member-by-category-last-month | 0 | yes | answer | answer | $0.062 | 17.8s |  |
| except-housing-last-month | 0 | yes | answer | answer | $0.059 | 18.9s |  |
| trend-six-months | 0 | yes | answer | answer | $0.036 | 9.8s |  |
| largest-five-last-month | 0 | yes | answer | answer | $0.030 | 7.9s |  |
| dining-three-months | 0 | yes | answer | answer | $0.044 | 12.5s |  |
| biggest-travel-twelve-months | 0 | yes | answer | answer | $0.041 | 13.7s |  |
| shopping-last-month | 0 | yes | answer | answer | $0.046 | 13.7s |  |
| busiest-day-last-month | 0 | yes | answer | answer | $0.062 | 18.9s |  |
| income-vs-spending | 0 | yes | answer | answer | $0.043 | 12.1s |  |
| refuse-weather | 0 | yes | refuse | refuse | $0.007 | 2.4s | out_of_scope |
| clarify-savings | 0 | yes | clarify | clarify | $0.008 | 3.1s |  |
| earned-minus-spent | 0 | **no** | answer | answer | $0.042 | 12.2s | income minus spending: no cell holds 1720.78 |
| clarify-yachts | 0 | yes | clarify | clarify | $0.009 | 3.7s |  |
| income-this-year | 0 | yes | answer | answer | $0.068 | 22.1s |  |
| infeasible-2015 | 0 | yes | infeasible | infeasible | $0.007 | 2.3s | infeasible |
