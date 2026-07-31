/**
 * Simulador del detector de cámara (solo desarrollo)
 * ==================================================
 * Sustituye al detector real, que es externo a este repositorio. Escucha en el
 * mismo puerto que él para que el navegador no necesite configuración: cada
 * Enter emite un `people_detected` y arranca una visita.
 *
 *   pnpm dev:detector          → ws://localhost:8765
 *   DETECTOR_PORT=8080 pnpm dev:detector
 *
 * No implementa `get_photo` ni `register_face`: el kiosko ya tolera su ausencia
 * (registra sin imagen tras el timeout).
 */
import { WebSocketServer, WebSocket } from "ws";
import readline from "node:readline";

const PORT = Number(process.env.DETECTOR_PORT || 8765);
const wss = new WebSocketServer({ port: PORT });
const clients = new Set();

console.log(`Simulador de detector en ws://localhost:${PORT}`);

wss.on("connection", (ws) => {
    console.log("Kiosko conectado");
    clients.add(ws);

    ws.on("message", (msg) => console.log("Kiosko:", msg.toString()));
    ws.on("close", () => {
        console.log("Kiosko desconectado");
        clients.delete(ws);
    });
});

/**
 * Escenarios de detección. El kiosko elige como protagonista al primer conocido
 * y, si no hay ninguno, al primer desconocido: estos cuatro cubren las dos
 * ramas y el caso mixto, que es el que se cuela en las pruebas a mano.
 */
const ESCENARIOS = {
    c: {
        nombre: "un conocido",
        evento: {
            type: "people_detected",
            total: 1,
            conocidos: [{
                track_id: 3, posicion: "derecha",
                persona_id: "p_a1b2c3d4",
                visitante: "Víctor Dávalos",
                procedencia: "Dominos",
                anfitrion: "Amalia Gastelum",
                visitas_previas: 4,
            }],
            desconocidos: [],
            desconocidos_track_ids: [],
        },
    },
    d: {
        nombre: "un desconocido",
        evento: {
            type: "people_detected",
            total: 1,
            conocidos: [],
            desconocidos: [{}],
            desconocidos_track_ids: [1],
        },
    },
    g: {
        nombre: "grupo mixto (1 conocido + 1 desconocido)",
        evento: {
            type: "people_detected",
            total: 2,
            conocidos: [{
                track_id: 3, posicion: "derecha",
                persona_id: "p_a1b2c3d4",
                visitante: "Víctor Dávalos",
                procedencia: "Dominos",
                anfitrion: "Amalia Gastelum",
                visitas_previas: 4,
            }],
            desconocidos: [{}],
            desconocidos_track_ids: [1],
        },
    },
    dd: {
        nombre: "dos desconocidos",
        evento: {
            type: "people_detected", total: 2,
            conocidos: [], desconocidos: [{}, {}], desconocidos_track_ids: [1, 2],
        },
    },
    n: {
        nombre: "sala vacía (todos se fueron)",
        evento: { type: "people_detected", total: 0, conocidos: [], desconocidos: [], desconocidos_track_ids: [] },
    },
    v: { nombre: "escena vacía", evento: { type: "scene_empty" } },
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log(
    Object.entries(ESCENARIOS)
        .map(([tecla, { nombre }]) => `'${tecla}' = ${nombre}`)
        .join(" | ") + " | Enter = un conocido",
);

rl.on("line", (line) => {
    const tecla = line.trim().toLowerCase() || "c";
    const escenario = ESCENARIOS[tecla];
    if (!escenario) return console.log(`Tecla desconocida: "${tecla}"`);

    // const escenario = {
    //     "type": "people_detected",
    //     "total": 2,
    //     "conocidos": [
    //         {
    //             "track_id": 3, "posicion": "derecha",
    //             "nombre": "Víctor Dávalos", "persona_id": "p_a1b2c3d4",
    //             "procedencia": "Dominos", "anfitrion_habitual": "Amalia Gastelum",
    //             "visitas_previas": 4
    //         }
    //     ],
    //     "desconocidos": [
    //         { "track_id": 1, "posicion": "izquierda" }
    //     ],
    //     "desconocidos_track_ids": [1]
    // }
    
    for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(escenario.evento));
    }
    console.log(`→ ${escenario.evento.type}: ${escenario.nombre} (${clients.size} cliente(s))`);
});
