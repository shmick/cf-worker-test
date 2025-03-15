interface Env {
  MY_BUCKET: R2Bucket;
}

interface CacheRequest {
  url: string;
}

async function createShortHash(url: string): Promise<string> {
  // Remove Discord's query parameters for consistent hashing
  const urlObj = new URL(url);
  urlObj.search = ''; // Remove all query parameters
  const urlWithoutParams = urlObj.toString();
  
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

function getAlternativeDiscordUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    if (urlObj.hostname === 'cdn.discordapp.com') {
      urlObj.hostname = 'media.discordapp.net';
      return urlObj.toString();
    }
    if (urlObj.hostname === 'media.discordapp.net') {
      urlObj.hostname = 'cdn.discordapp.com';
      return urlObj.toString();
    }
  } catch (e) {
    return url;
  }
  return url;
}

function cleanDiscordUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    // Keep only essential query parameters
    const newSearchParams = new URLSearchParams();
    
    // Only keep format and quality if they exist
    if (urlObj.searchParams.has('format')) {
      newSearchParams.set('format', urlObj.searchParams.get('format')!);
    }
    if (urlObj.searchParams.has('quality')) {
      newSearchParams.set('quality', urlObj.searchParams.get('quality')!);
    }
    
    urlObj.search = newSearchParams.toString();
    return urlObj.toString();
  } catch (e) {
    return url;
  }
}

const browserHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://discord.com/',
  'Origin': 'https://discord.com',
  'Sec-Fetch-Dest': 'image',
  'Sec-Fetch-Mode': 'no-cors',
  'Sec-Fetch-Site': 'cross-site',
  'Pragma': 'no-cache',
  'Cache-Control': 'no-cache'
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (request.method === 'POST' && url.pathname === '/cache') {
        let body;
        try {
          body = await request.json() as CacheRequest;
        } catch (e) {
          return new Response(JSON.stringify({
            status: 'error',
            message: 'Invalid JSON in request body'
          }), { 
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        const { url: discordUrl } = body;
        
        if (!discordUrl) {
          return new Response(JSON.stringify({
            status: 'error',
            message: 'URL is required in request body'
          }), { 
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        if (!isDiscordUrl(discordUrl)) {
          return new Response(JSON.stringify({
            status: 'error',
            message: 'Invalid Discord URL',
            provided_url: discordUrl
          }), { 
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        try {
          let discordUrlToTry = cleanDiscordUrl(discordUrl);
          let response = await fetch(discordUrlToTry, { headers: browserHeaders });
          let attemptedUrls = [discordUrlToTry];

          // If first attempt fails, try alternative URL
          if (!response.ok && response.status === 403) {
            const altUrl = getAlternativeDiscordUrl(discordUrlToTry);
            if (altUrl !== discordUrlToTry) {
              discordUrlToTry = altUrl;
              attemptedUrls.push(discordUrlToTry);
              response = await fetch(discordUrlToTry, { headers: browserHeaders });
            }
          }

          // Try without any query parameters as last resort
          if (!response.ok && response.status === 403) {
            const urlObj = new URL(discordUrlToTry);
            urlObj.search = '';
            discordUrlToTry = urlObj.toString();
            attemptedUrls.push(discordUrlToTry);
            response = await fetch(discordUrlToTry, { headers: browserHeaders });
          }

          if (!response.ok) {
            return new Response(JSON.stringify({
              status: 'error',
              message: `Failed to fetch Discord image: ${response.status} ${response.statusText}`,
              url: discordUrl,
              attempted_urls: attemptedUrls,
              headers: Object.fromEntries(response.headers)
            }), { 
              status: response.status,
              headers: { 'Content-Type': 'application/json' }
            });
          }

          const contentType = response.headers.get('content-type');
          if (!contentType?.startsWith('image/')) {
            return new Response(JSON.stringify({
              status: 'error',
              message: 'Invalid content type',
              content_type: contentType
            }), { 
              status: 400,
              headers: { 'Content-Type': 'application/json' }
            });
          }

          const clonedResponse = response.clone();

          const pathParts = new URL(discordUrlToTry).pathname.split('/');
          const fileName = pathParts[pathParts.length - 1].split('?')[0];
          const fileExt = fileName.split('.').pop()?.toLowerCase() || '';

          if (!fileExt || !['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(fileExt)) {
            return new Response(JSON.stringify({
              status: 'error',
              message: 'Invalid file extension',
              extension: fileExt
            }), { 
              status: 400,
              headers: { 'Content-Type': 'application/json' }
            });
          }

          const shortHash = await createShortHash(discordUrl);
          const date = new Date();
          const folderName = date.getFullYear().toString() +
            (date.getMonth() + 1).toString().padStart(2, '0') +
            date.getDate().toString().padStart(2, '0');

          const fullPath = `${folderName}/${shortHash}.${fileExt}`;

          await env.MY_BUCKET.put(fullPath, clonedResponse.body, {
            contentType: contentType,
            httpMetadata: {
              cacheControl: 'public, max-age=31536000'
            }
          });

          return new Response(JSON.stringify({
            status: 'success',
            cached_url: `https://imgcdn.ww0.ca/${fullPath}`,
            original_url: discordUrl,
            final_url: discordUrlToTry,
            hash: shortHash,
            path: fullPath
          }), {
            headers: { 'Content-Type': 'application/json' }
          });

        } catch (error) {
          return new Response(JSON.stringify({
            status: 'error',
            message: `Fetch error: ${error instanceof Error ? error.message : 'Unknown error'}`,
            url: discordUrl
          }), { 
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }

      if (request.method === 'GET' && url.pathname !== '/cache') {
        const obj = await env.MY_BUCKET.get(url.pathname.substring(1));
        if (obj === null) {
          return new Response('File not found', { 
            status: 404,
            headers: { 'Content-Type': 'text/plain' }
          });
        }

        const headers = new Headers();
        headers.set('content-type', obj.httpMetadata?.contentType || 'application/octet-stream');
        headers.set('cache-control', 'public, max-age=31536000');
        return new Response(obj.body, { headers });
      }

      return new Response('Not found', { 
        status: 404,
        headers: { 'Content-Type': 'text/plain' }
      });

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
