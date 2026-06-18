const PLAN_BLOCK_RE = /<!--\s*PLAN_START\s*-->[\s\S]*?<!--\s*PLAN_END\s*-->/;
const REJECTION_WORDS = /^(n|no|cancel|stop|reject|nope|abort|dont|don't)[\s.!]*$/i;

// Test 1: Plan block detected
const mockResponse = '<!-- PLAN_START -->\n## Implementation Plan\n**Summary:** Add JWT auth\n<!-- PLAN_END -->\nAwaiting your approval.';
console.log('Test 1 - Plan block detected:', PLAN_BLOCK_RE.test(mockResponse) === true ? 'PASS' : 'FAIL');

// Test 2: No plan block in normal response
const normalResp = 'Here is a simple bug fix.';
console.log('Test 2 - Normal response no plan:', !PLAN_BLOCK_RE.test(normalResp) === true ? 'PASS' : 'FAIL');

// Test 3: Rejection words work correctly
console.log('Test 3a - "n" rejected:', REJECTION_WORDS.test('n') ? 'PASS' : 'FAIL');
console.log('Test 3b - "no" rejected:', REJECTION_WORDS.test('no') ? 'PASS' : 'FAIL');
console.log('Test 3c - "cancel" rejected:', REJECTION_WORDS.test('cancel') ? 'PASS' : 'FAIL');
console.log('Test 3d - "reject" rejected:', REJECTION_WORDS.test('reject') ? 'PASS' : 'FAIL');

// Test 4: Approval words NOT rejected
console.log('Test 4a - "y" NOT rejected:', !REJECTION_WORDS.test('y') ? 'PASS' : 'FAIL');
console.log('Test 4b - "yes" NOT rejected:', !REJECTION_WORDS.test('yes') ? 'PASS' : 'FAIL');
console.log('Test 4c - "proceed" NOT rejected:', !REJECTION_WORDS.test('proceed') ? 'PASS' : 'FAIL');
console.log('Test 4d - "approve" NOT rejected:', !REJECTION_WORDS.test('approve') ? 'PASS' : 'FAIL');

// Test 5: Plan in middle of response (before/after text)
const mixedResp = 'Here is my plan:\n<!-- PLAN_START -->\n1. Do thing A\n2. Do thing B\n<!-- PLAN_END -->\nDo you approve?';
console.log('Test 5 - Plan in middle of response:', PLAN_BLOCK_RE.test(mixedResp) === true ? 'PASS' : 'FAIL');

console.log('\nAll tests complete.');
