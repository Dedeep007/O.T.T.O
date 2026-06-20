const response = `It seems there might be an issue with the \`server.js\` file not being found or properly installed. Let's ensure that everything is set up correctly:

1. **Create the \`server.js\` file**:
   - Open a new file named \`server.js\` in your project directory.
   - Add the following code to serve static files and handle the \`/api/login\` endpoint:

     \`\`\`javascript
     const http = require('http');
     const fs = require('fs');
     const path = require('path');

     // Serve static files from a public directory
     const publicDir = path.join(__dirname, 'public');
     const server = http.createServer((req, res) => {
       if (req.method === 'GET' && req.url.startsWith('/')) {
         const filePath = path.join(publicDir, decodeURIComponent(req.url));
         fs.readFile(filePath, (err, data) => {
           if (err) {
             res.writeHead(404);
             res.end('File not found');
           } else {
             res.writeHead(200, { 'Content-Type': 'text/html' });
             res.end(data);
           }
         });
       } else if (req.method === 'POST' && req.url === '/api/login') {
         const body = [];
         req.on('data', chunk => {
           body.push(chunk);
         }).on('end', () => {
           const credentials = JSON.parse(body.toString());
           if (credentials.username === 'admin' && credentials.password === 'admin') {
             res.writeHead(200, { 'Content-Type': 'application/json' });
             res.end(JSON.stringify({ message: 'Login successful' }));
           } else {
             res.writeHead(401);
             res.end('Invalid credentials');
           }
         });
       } else {
         res.writeHead(404);
         res.end('Not found');
       }
     });

     // Start the server on port 3001
     const PORT = process.env.PORT || 3001;
     server.listen(PORT, () => {
       console.log(\`Server running at http://localhost:\${PORT}\`);
     });
     \`\`\`

2. **Create a \`public\` directory**:
   - Inside your project directory, create a new folder named \`public\`.
   - Add an \`index.html\` file to the \`public\` directory with the following content:

     \`\`\`html
     <!DOCTYPE html>
     <html lang="en">
     <head>
       <meta charset="UTF-8">
       <meta name="viewport" content="width=device-width, initial-scale=1.0">
       <title>Login</title>
     </head>
     <body>
       <h1>Login</h1>
       <form id="loginForm">
         <label for="username">Username:</label>
         <input type="text" id="username" name="username"><br><br>
         <label for="password">Password:</label>
         <input type="password" id="password" name="password"><br><br>
         <button type="submit">Login</button>
       </form>

       <script>
         document.getElementById('loginForm').addEventListener('submit', async (e) => {
           e.preventDefault();
           const username = document.getElementById('username').value;
           const password = document.getElementById('password').value;

           try {
             const response = await fetch('/api/login', {
               method: 'POST',
               headers: {
                 'Content-Type': 'application/json'
               },
               body: JSON.stringify({ username, password })
             });

             if (response.ok) {
               alert(response.json().message);
             } else {
               alert('Login failed');
             }
           } catch (error) {
             console.error('Error:', error);
             alert('An error occurred during login');
           }
         });
       </script>
     </body>
     </html>
     \`\`\`

3. **Start the backend server**:
   - Run the following command to start the server in the background:

     \`\`\`json
     {
       "name": "execute_terminal_command",
       "arguments": {
         "command": "node server.js &"
       }
     }
     \`\`\`

4. **Verify that the server started successfully**:
   - Check your terminal output to ensure that the server is running on port 3001.

5. **Test the login functionality**:
   - Open a web browser and navigate to \`http://localhost:3001\`.
   - Enter \`admin\` as both the username and password in the form and submit it.
   - You should see an alert indicating that the login was successful.

If you encounter any further issues, please provide more details for troubleshooting.`;

const trimmed = response.trim();
const blockRegex = /```(bash|sh|shell|powershell|cmd|ps1|javascript|typescript|js|ts|json|html|css)?\s*([\s\S]*?)\s*```/g;
let blockMatch;
let lastIdx = 0;

while ((blockMatch = blockRegex.exec(trimmed)) !== null) {
  const lang = (blockMatch[1] || '').toLowerCase();
  const code = blockMatch[2].trim();
  const preText = trimmed.substring(lastIdx, blockMatch.index).trim();
  lastIdx = blockRegex.lastIndex;

  console.log(`\n--- Block match found ---`);
  console.log("lang:", lang);
  console.log("preText (last 150 chars):", preText.slice(-150));
  
  const fileMatch = preText.match(/(?:file|to|named|in|create|write)\s+`?([a-zA-Z0-9_\-\.\/\\:]+\.[a-zA-Z0-9_]+)`?/i);
  console.log("fileMatch:", fileMatch);
}
