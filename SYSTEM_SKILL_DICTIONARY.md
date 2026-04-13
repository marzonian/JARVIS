# System Skill Dictionary

## Purpose
Defines Jarvis skill contracts so routing is capability-based instead of keyword patching.

## TradingDecision
- `intents`: `trading_decision`, `trading_plan`, `trading_execution_request`
- `tools`: `RiskTool`, `Health`, `Analyst`
- `requires`: fresh bars for analysis; explicit confirm for execution requests
- `safe failure`: health/risk block with reason and next condition
- `trace proof`: `precedenceMode`, `decisionBlockedBy`, `riskVerdict`, `toolsUsed`

## TradingStatus
- `intents`: `trading_status`
- `tools`: `Health`, `Analyst`
- `requires`: market freshness snapshot
- `safe failure`: no stale trend/ORB claims
- `trace proof`: `healthStatusUsed`, `lastHealthAgeSeconds`

## TradingReplay
- `intents`: `trading_hypothetical`, `trading_replay`, `trading_review`
- `tools`: `ReplayTool`, `Health`, `RiskTool`
- `requires`: enough bars for replay window
- `safe failure`: explicit missing-data message
- `trace proof`: replay receipt (`dataSource`, `executed`, `outcomeHypothetical`)

## LocalSearch
- `intents`: `local_search`, `web_local_search`
- `tools`: `LocationStore`, `ConsentFSM`, `WebTool`
- `requires`: location + search consent
- `state`: `location_needed` → `confirm_search` → `results_presented` → `confirm_directions_select` → `confirm_directions_execute`
- `safe failure`: no fake lookup claims when stub/disabled/failure
- `trace proof`: `consentKind`, `toolReceipts`, `web.providerAttempts`, `resultCount`

## WebSearch
- `intents`: `web_question`
- `tools`: `ConsentFSM`, `WebTool`
- `requires`: consent before network action
- `safe failure`: explicit “did not run search” when blocked/offline
- `trace proof`: web receipts with `executed` + provider metadata

## ShoppingAdvisor
- `intents`: `shopping_advisor`
- `tools`: `AdvisorPlanner`, `MemoryStore`
- `requires`: budget + form factor + monitor count
- `state`: `intake` → `plan_ready`
- `safe failure`: asks one targeted missing-input question
- `trace proof`: `selectedSkill=ShoppingAdvisor`, planner profile/result

## ProjectPlanner
- `intents`: `project_planner`
- `tools`: `AdvisorPlanner`, `MemoryStore`
- `requires`: business context + audience + primary goal
- `state`: `intake` → `brief_ready`
- `safe failure`: asks one targeted missing-input question
- `trace proof`: `selectedSkill=ProjectPlanner`, brief + plan payload

## ComplaintLogging
- `intents`: `complaint_log`
- `tools`: `ComplaintStore`, `TraceStore`
- `requires`: prompt + reply context
- `safe failure`: validation error if required fields missing
- `trace proof`: complaint id + stored metadata

## ImprovementReview
- `intents`: `improvement_review`
- `tools`: `ImprovementEngine`, `ComplaintStore`, `TraceStore`
- `requires`: complaint sample window
- `safe failure`: transparent “insufficient pattern” outcome
- `trace proof`: `suggestionCount`, `requiresPermission=true`

## DeviceAction
- `intents`: `device_action`, `os_action`
- `tools`: `ConsentFSM`, `OS Agent`
- `requires`: explicit confirm + allowlist
- `safe failure`: no execution when unconfirmed/unsupported
- `trace proof`: confirmation state + execution receipt

## MemoryPreference
- `intents`: `memory_query` + direct preference statements
- `tools`: `MemoryStore`, `ConsentFSM`
- `requires`: contradiction confirmation before overwrite
- `safe failure`: no silent overwrite
- `trace proof`: contradiction prompt + update/cancel record

## SystemDiagnostic
- `intents`: `system_diag`
- `tools`: `DiagTool`, `TraceStore`
- `requires`: none
- `safe failure`: deterministic route disclosure
- `trace proof`: `routePathTag=jarvis_orchestrator.system_diag`

## GeneralConversation
- `intents`: `general_chat`, `unclear`
- `tools`: `Jarvis`
- `requires`: none
- `safe failure`: one clarify question, no cross-domain leakage
- `trace proof`: `toolsUsed=["Jarvis"]`, firewall fields
