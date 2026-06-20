import stringWidth from 'string-width';

console.log("Imported string-width successfully!");
console.log("Width of 📋:", stringWidth('📋'));
console.log("Width of ✅:", stringWidth('✅'));
console.log("Width of ❌:", stringWidth('❌'));
console.log("Width of ✏️:", stringWidth('✏️'));
console.log("Width of ▶:", stringWidth('▶'));
console.log("Width of em-dash —:", stringWidth('—'));
console.log("Width of menu item 1:", stringWidth('\u2705  Approve \u2014 execute the plan'));
console.log("Width of menu item 2:", stringWidth('\u270f\ufe0f   Edit \u2014 request changes first'));
console.log("Width of menu item 3:", stringWidth('\u274c  Cancel \u2014 do not proceed'));
