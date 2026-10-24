# Navigating Challenges: pivot log

This file records what didn't work, what we learned, and how we changed course. It supports the HackOHI/O rubric criterion **Navigating Challenges** (Creating Value → Growth):

> *Testing ideas, recognizing barriers or failures as important moments of feedback and pivoting accordingly.*
> **5 points:** "Alternatives created more successful solution."

Each entry follows the same shape: **what we tried → what we found (evidence) → alternatives we considered → what we chose → why it's better.** Keep adding entries during the build (template at the bottom).

---

## Quick answer for the judges

> *"Name one thing that you struggled with or something that just didn't work at all and how did you pivot your plan from there."*

**Short answer:** "We planned to predict restoration time from historical repair dates. When we tested that data, the dates turned out to be day-level only, and some were paperwork closeouts weeks later. There were also no crew counts, so a model trained on them couldn't respond when you change the number of crews. We pivoted to a hybrid. Trained models predict risk, expected damage and access problems, where the data does record the outcome. Restoration time comes from a simulator built on AEP's labor-hour workbook, so every input judges change has a clear, explainable effect."

**How we tested ideas:** we checked every assumption against the actual data before building on it (counts, distributions, sample rows). We also checked the plan against the AEP brief and the judging rubric, line by line.

---

## Pivot log (planning phase, 24 Oct 2026)

### 1. From "dashboard + live mock data" to a customer journey backed by analysis
| | |
|---|---|
| **Tried** | Original idea: a general-information dashboard with "live updates" from the mock data, plus an AI chatbot for personal questions. |
| **Found** | Checking it against the AEP brief line by line showed it covered only about 40% of what's judged. There was no risk prediction, no restoration range, no alert rules, no messages, and no privacy or uncertainty handling. Random "live" numbers wouldn't score. |
| **Alternatives** | Keep the general dashboard and add features to it · rebuild around the brief's six required demo steps |
| **Chose** | A customer-centred journey (my location → my risk → my restoration time → what to do → my alerts). "Live updates" became a **storm-timeline simulation** that drives the estimates and the four required messages. |
| **Better because** | Every screen now maps to a judged requirement, and the "live" element now means something. |

### 2. The chatbot must not make up numbers
| | |
|---|---|
| **Tried** | A chatbot that answers personal questions directly. |
| **Found** | An LLM producing risk percentages or restoration times on its own would fail the brief's responsible-AI requirements (transparency, no false precision) and could leak private data. |
| **Alternatives** | Free-form chatbot with a disclaimer · chatbot that only narrates results from our own calculations |
| **Chose** | **Tools-only design:** the chatbot calls our risk / restoration / guidance / alert functions and explains their results. The tools return only sanitized data. |
| **Better because** | It can't make up numbers or leak private data, and every answer is traceable in the audit log. |

### 3. Repair dates couldn't be used to calculate restoration time
| | |
|---|---|
| **Tried** | Using ARCOS report and repair dates to learn how long restoration takes. |
| **Found** | Dates are **day-level only**. For the Sep 2024 storm, the median report-to-repair gap is **23 days**, which looks like administrative closeout, not restoration. Feb 2025 looks realistic (90% within 2 days). |
| **Alternatives** | Use the dates anyway · drop the Sep 2024 storm · get hours from another source |
| **Chose** | Restoration hours come from the **labor workbook** (per-part install/removal hours × the 4.5 multiplier). Feb 2025 dates are used only as a **sanity check**. |
| **Better because** | Hour-level estimates that can be explained, instead of noisy day counts. |

### 4. Rejected a trained model for restoration time; switched to a hybrid
| | |
|---|---|
| **Tried** | Training an AI model to predict restoration time directly from the provided data, with judges changing inputs. |
| **Found** | The data has **no crew counts and no network or switching details**. A trained model couldn't learn how crews or network options affect restoration, so it wouldn't respond correctly when judges move those controls, and it couldn't explain itself. |
| **Alternatives** | Trained model end to end · rules-only simulator · hybrid |
| **Chose** | **Hybrid:** trained models where the data records the outcome (outage risk, expected damage, access problems) **feed** a simulator built on the labor workbook. |
| **Better because** | Uses machine learning where it's valid and gives explainable, responsive results for every judge input. |

### 5. "Directions to the nearest hospital" was unsafe
| | |
|---|---|
| **Tried** | Telling customers in a medical emergency where the nearest hospital or fire station is. |
| **Found** | In the facility data, **2 of the 5 hospitals aren't general emergency rooms** (a psychiatric hospital and a VA medical center). Most ambulance stations are volunteer squads. During a storm, roads may be blocked. |
| **Alternatives** | Nearest facility by distance · filtered list · 911-first |
| **Chose** | **Emergency → "Call 911" first**, clearly labelled. Facility data is used instead for **restoration priority** (critical facilities get repaired first). |
| **Better because** | It can't send someone to the wrong place, and the data still adds value where it's reliable. |

### 6. Found a gap against the judging criteria: network assumptions
| | |
|---|---|
| **Tried** | Controls for crews, storm severity and access only. |
| **Found** | The brief says the estimate must update when *"damage, crew, access, or network assumptions change."* Network had no control. |
| **Chose** | Added **switching on/off**, **upstream device failed** and **critical-facilities-first** controls, plus a **before/after note** on every change explaining what moved and why. |
| **Better because** | All four inputs the brief names can be changed and are explained. |

### 7. Data quality: a wrong assumption caught before building on it
| | |
|---|---|
| **Tried** | Assumed the 76 unrepaired damage records shared one placeholder repair date. |
| **Found** | Checking the data showed **mixed dates** (mostly Oct–Dec 2025, some in 2026). |
| **Chose** | Treat repair dates on unrepaired rows as null, whatever their value. |
| **Lesson** | **Check data before writing a cleaning rule.** We now check counts and samples for every rule. |

### 8. Shapefile reading produced shifted columns
| | |
|---|---|
| **Tried** | A quick custom reader for the shapefile attribute tables (no geospatial libraries were installed). |
| **Found** | The first version read the header wrong, so every value landed under the wrong column (e.g. dates under "Circuit"). |
| **Chose** | Fixed the header parsing, and added a **sample-row check against known values** (e.g. circuit names look like `CIR60`, coordinates fall in the Roanoke area). For the real build: proper libraries on AWS SageMaker. |
| **Lesson** | Always inspect sample rows after loading, not just row counts. |

### 9. Data cleaning plan changed three times as the team changed
| | |
|---|---|
| **Tried** | (a) Two cleaners splitting by task with a hand-off → (b) two cleaners splitting by file with joint integration → (c) team went from 4 to 3 people. |
| **Found** | (a) made one person wait for the other. (c) left one person doing all the cleaning while the ML teammate needed data early. |
| **Chose** | **One data owner cleaning in 4 batches**, ordered so the ML teammate gets the training data first (~hour 5). Feature engineering moved to the ML teammate. A one-circuit sample is uploaded at ~hour 1.5 so ML can start straight away. |
| **Better because** | Nobody is blocked, and each person owns a clear piece. |

### 10. Tools and budget: chose the right AWS tools for a $300 limit
| | |
|---|---|
| **Tried** | Considered AWS Glue / DataBrew for cleaning, and live SageMaker endpoints for serving. |
| **Found** | Glue doesn't read shapefiles natively and is overkill for ~32 MB. Always-on endpoints, GPUs and idle notebooks are the main ways to burn through a $300 credit. |
| **Chose** | **SageMaker Studio notebooks** (CPU) for cleaning and training. **The app downloads the model files from S3 and predicts itself.** Budget alerts, idle shutdown, CPU-only permissions. Expected spend ~$40–80. |
| **Better because** | Fits the budget with room to spare, and the demo still works if AWS is slow. |

### 11. Feature review caught placeholder pole dates
| | |
|---|---|
| **When** | Build day, after feature engineering · data owner + ML teammate |
| **Tried** | Computed pole age from the raw install dates. |
| **Found** | Reviewing the feature table showed a maximum zone pole age of **126 years**. The raw data has **80 poles dated 1900 or 1800**, which are placeholders for "unknown", not real dates. |
| **Alternatives** | Keep them · cap ages · treat as unknown |
| **Chose** | Set install years of 1900 and earlier to unknown (the 3 poles dated 1906–1909 look real and were kept), re-uploaded `pole.parquet`, recomputed pole features |
| **Better because** | Removes a false "very old poles" signal that would have pushed risk up in a few zones. **Lesson:** review feature distributions (min/max), not just row counts. |

---

## Lessons learned (summary)

1. **Check every assumption against the data before building on it** (entries 3, 7, 8).
2. **Use machine learning only where the data records the outcome.** Use explainable rules elsewhere (entry 4).
3. **Check the plan against both the brief and the rubric** early and often (entries 1, 6).
4. **Safety beats convenience** for emergency features (entry 5).
5. **Plan around team dependencies:** order work so nobody waits (entry 9).

---

## Template for new entries (during the build)

```markdown
### N. <short title>
| | |
|---|---|
| **When** | <hour of hackathon> · <who> |
| **Tried** | <what we did or assumed> |
| **Found** | <what went wrong, with evidence: error, metric, test result, feedback> |
| **Alternatives** | <options considered> |
| **Chose** | <what we did instead> |
| **Better because** | <result, ideally measured: AUC went from X to Y, estimate now within Z> |
```

**Worth logging when it happens:** a model that underperforms (and what replaced it), a damage-matching rate that's too low, user-test feedback that changed the UI, AWS problems, a feature cut for time (from the cut list in the MVP plan), and any mentor answer that changed an assumption.
