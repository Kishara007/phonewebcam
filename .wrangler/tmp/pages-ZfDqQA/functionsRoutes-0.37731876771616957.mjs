import { onRequestGet as __api_ice_servers_ts_onRequestGet } from "C:\\Users\\-e-\\Downloads\\DEVELOPMENTS\\ToolS Websites\\phonewebcam\\phonewebcam\\functions\\api\\ice-servers.ts"

export const routes = [
    {
      routePath: "/api/ice-servers",
      mountPath: "/api",
      method: "GET",
      middlewares: [],
      modules: [__api_ice_servers_ts_onRequestGet],
    },
  ]