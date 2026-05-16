export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/yc")) {
      return new Response("Not found", { status: 404 });
    }

    if (url.pathname === "/yc") {
      url.pathname = "/yc/";
      return Response.redirect(url.toString(), 301);
    }

    let targetPath = url.pathname.replace(/^\/yc\/?/, "/yc/");
    if (targetPath === "/yc/") {
      targetPath = "/yc/index.html";
    }

    const targetUrl = new URL(
      `https://ycpos.freshstack.cc${targetPath}${url.search}`
    );

    const response = await fetch(targetUrl.toString(), {
      headers: {
        "User-Agent": "FreshStack-Order-Worker"
      }
    });

    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.delete("content-security-policy");

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }
};
