// The offline suite has no internet and wants none. Hand it a directory.
//
// Same idea as `apiKey: 'test-key'`: the test provides the world, so the code
// under test is the real code. Call it before the first save_fields — the
// directory is cached, so one stub covers a whole file.
export function stubHosts(anfitriones = ['Amalia Gastelum', 'Laura Mendoza']) {
  globalThis.fetch = async () => new Response(JSON.stringify({ anfitriones }), { status: 200 });
}
