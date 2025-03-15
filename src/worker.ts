interface Env {
  MY_BUCKET: R2Bucket;
}

async function createShortHash(url: string): Promise<string> {
  const urlWithoutParams = url.split('?')[0];
  const msgBuffer = new TextEncoder().encode(urlWithoutParams);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 8);
}

function isDiscordUrl(url: string): boolean {
  try {
    const urlObj = new URL(url);
    const validDomains = [
      'cdn.discordapp.com',
      'media.discordapp.net',
      'images-ext-1.discordapp.net'
    ];
    
    if (!validDomains.some(domain => urlObj.hostname === domain)) {
      return false;
    }

    return urlObj.pathname.includes('/attachments/') || 
           urlObj.pathname.includes('/external/');
  } catch (e) {
    return false;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (request.method === 'POST' && url.pathname === '/cache') {
        const { url: discordUrl } = await request.json() as { url: string };
        
        if (!discordUrl || !isDiscordUrl(discordUrl)) {
          return new Response(JSON.stringify({
            status: 'error',
            message: 'Invalid Discord URL'
          }), { 
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        const response = await fetch(discordUrl);
        if (!response.ok) {
          return new Response(JSON.stringify({
            status: 'error',
            message: 'Failed to fetch Discord image'
          }), { 
            status: response.status,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        const clonedResponse = response.clone();

        const pathParts = new URL(discordUrl).pathname.split('/');
        const fileName = pathParts[pathParts.length - 1];
        const fileExt = fileName.split('?')[0].split('.').pop()?.toLowerCase() || '';

        const shortHash = await createShortHash(discordUrl);

        const date = new Date();
        const folderName = date.getFullYear().toString() +
          (date.getMonth() + 1).toString().padStart(2, '0') +
          date.getDate().toString().padStart(2, '0');

        const fullPath = `${folderName}/${shortHash}.${fileExt}`;

        await env.MY_BUCKET.put(fullPath, clonedResponse.body, {
          contentType: response.headers.get('content-type'),
          httpMetadata: {
            cacheControl: 'public, max-age=31536000'
          }
        });

        return new Response(JSON.stringify({
          status: 'success',
          cached_url: `https://imgcdn.ww0.ca/${fullPath}`
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (request.method === 'GET' && url.pathname !== '/cache') {
        const obj = await env.MY_BUCKET.get(url.pathname.substring(1));
        if (obj) {
          const headers = new Headers();
          headers.set('content-type', obj.httpMetadata?.contentType || 'application/octet-stream');
          headers.set('cache-control', 'public, max-age=31536000');
          return new Response(obj.body, { headers });
        }
        
        return new Response('File not found', { status: 404 });
      }

      return new Response('Not found', { status: 404 });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return new Response(JSON.stringify({
        status: 'error',
        message: errorMessage
      }), { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};
