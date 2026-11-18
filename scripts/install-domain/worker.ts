const cdn = "https://d2ikbbcl3j6jz9.cloudfront.net";
const artifacts = new Map([
  ["/install.sh", `${cdn}/cli/simplex-installer/stable/install.sh`],
  ["/stack.sh", `${cdn}/cli/localmodels/stable/stack.sh`],
]);

export default {
  async fetch(request: Request): Promise<Response> {
    const artifact = artifacts.get(new URL(request.url).pathname);
    if (!artifact) {
      return new Response(null, { status: 404 });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    }

    try {
      const response = await fetch(artifact, {
        method: request.method,
        redirect: "manual",
      });
      const mediaType = response.headers.get("content-type")?.split(";")[0];
      if (response.status === 200 && mediaType === "text/x-shellscript") {
        return response;
      }
      await response.body?.cancel();
    } catch {
      return new Response(null, { status: 502 });
    }
    return new Response(null, { status: 502 });
  },
};
