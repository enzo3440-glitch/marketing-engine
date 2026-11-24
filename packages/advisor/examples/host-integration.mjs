import {createAdvisor} from '../src/advisor.mjs';
import {FileLedger} from '../src/ledger.mjs';
// Replace with your DB and server-side model calls. Never expose secrets in browser bundles.
export function buildHostAdvisor({generateStructuredJson,readEvidenceByIds,modelLabel,ledgerPath}){
 return createAdvisor({provider:{model:modelLabel,generate:generateStructuredJson},evidenceStore:{getMany:readEvidenceByIds},ledger:new FileLedger(ledgerPath)});
}
// In your existing authenticated route: authorize user and tenant, validate request size/schema,
// resolve only tenant-owned evidence IDs, then call advisor.propose. This package has no public server.
