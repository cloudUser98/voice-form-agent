// Everything that leaves the building. One function per endpoint, plain fetch,
// no state beyond a short cache of the directory. The engine never imports this
// file: a form does.

// It dosen't matter this is hardcoded
const ODRIL_JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpYXQiOjE3ODYxMjA3NzcsIm5iZiI6MTc4NjEyMDc3NywianRpIjoiYzQ2MjM2NzItNzY5OS00ZGVlLWEwMDktZmRiYzk2NzY1OThhIiwiaWRlbnRpdHkiOiI5ZmY0ZTc0Yi04NDk2LWZiNGEtM2E3OC01YjNhNzU4OTNiYmUiLCJmcmVzaCI6ZmFsc2UsInR5cGUiOiJhY2Nlc3MifQ.lglcu_5SkbdAgkvNalyvEUSRXEwwVtIbItjPHQgjDRQ";

const HOSTS_URL = process.env.HOSTS_URL || 'https://swuepazoq5.execute-api.us-west-2.amazonaws.com/dev/bot/ishost';
const VISIT_URL = process.env.HOSTS_URL || 'https://swuepazoq5.execute-api.us-west-2.amazonaws.com/dev/visits';
const TTL_MS = 60_000;

// let cache = { at: 0, list: null };

/**
 * GET /hosts -> { anfitriones: [...] }
 *
 * Throws on anything that is not a 200 carrying that shape — the caller turns
 * every failure into the same refusal, so there is nothing to distinguish here.
 * Cached briefly: a lobby full of people should not re-download the staff list
 * once per visitor.
 */
 export async function getHosts(name, { timeoutMs = 5000 } = {}) {
     // if (cache.list && Date.now() - cache.at < TTL_MS) return cache.list;
     
     const thread = "thread_KWKlERYYTj2MosSP7WmCLlG1";
     
     console.log(HOSTS_URL, { thread_id: thread, prompt: name });
     const res = await fetch(
         HOSTS_URL,
         {
             method: "POST",
             headers: {
                 'Content-Type': 'application/json',
                 'Accept': 'application/json',
                 "Authorization": `Bearer ${ODRIL_JWT}`
             },
             body: JSON.stringify({ thread_id: thread, prompt: name })
             // signal: AbortSignal.timeout(timeoutMs),
         }
     );
     console.log("Host response: ", res);
     // if (res.status !== 200) throw new Error(`hosts: HTTP ${res.status}`);

     // const { anfitrionData: data } = await res.json();

     // cache = { at: Date.now(), list: anfitrionData };
     // return anfitrionData;
     console.log("Returning true");
     return true;
 }
 
export async function registerVisit(data, { timeoutMs = 5000 } = {}) {
    let body = {
        "name": data.visitante,
        "establecimiento_id": "a478e113-3c7d-4b81-037b-5b3a75adf60d",
        "asunto_id": "1453a17d-119e-b2d0-c301-580a5ff2af11",
        "detalle_asunto": "",
        "procedencia": data.procedencia,
        "anfitrion_id": "64fdd854-ced5-485d-a176-b66af96a5393",
        "imagen_auto": "",
        "imagen_placas": "",
        "android_id": "web",
        "placas": "",
        "color": "",
        "marca": "0",
        "modelo": "0",
        "tipo_registro": "1",
        // "custom": [
        //     {
        //         "e6327a77-e25b-40f1-81c7-8948fbb6266b": "prueba",
        //         "type": 2
        //     },
        //     {
        //         "78b8f1c5-4461-425b-ae90-4bf5b83b16fd": "4783a232-bb0e-41bd-bd66-19470a35d7f9",
        //         "type": 3
        //     }
        // ],
        "imagen_ine_1": "",
        "imagen_ine_2": "",
        "imagen_principal": data.foto || ""
    }
    
    const res = await fetch(
        VISIT_URL,
        {
            method: "POST",
            body: JSON.stringify(body),
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                "Authorization": `Bearer ${ODRIL_JWT}`
            },
            signal: AbortSignal.timeout(timeoutMs),
        }
    );
    console.log("Visit response: ", res);
    if (res.status !== 200) throw new Error(`hosts: HTTP ${res.status}`);

    // const { anfitrionData: data } = await res.json();

    // cache = { at: Date.now(), list: anfitrionData };
    return true;
}

// const words = (s) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '')
//   .toLowerCase().split(/\s+/).filter(Boolean);

/**
 * Is this somebody the directory knows? Matching is by word, ignoring accents
 * and case, so "Carlos" and "carlos nunez" both find "Carlos Núñez" — a visitor
 * says a name out loud, not a database key.
 */
// export async function existsHost(name) {
//   const asked = words(name);
//   if (!asked.length) return false;

//   return (await getHosts()).some((h) => {
//     const has = words(h);
//     return asked.every((w) => has.includes(w));
//   });
// }