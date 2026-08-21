import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 通用多组件夹具：Meteor 形状的 node 应用 + docker-compose mongo。
 * 不是某个产品仓库的克隆。
 */
export function createMeteorComposeFixture(dir: string): void {
  mkdirSync(join(dir, ".meteor"), { recursive: true });
  writeFileSync(join(dir, ".meteor", "release"), "METEOR@2.16\n");
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: "sample-multicomponent-app",
        private: true,
        scripts: { start: "meteor" },
        meteor: {
          mainModule: {
            client: "client/main.js",
            server: "server/main.js"
          }
        },
        dependencies: {
          "meteor-node-stubs": "1.2.5"
        }
      },
      null,
      2
    )}\n`
  );
  writeFileSync(
    join(dir, "docker-compose.yml"),
    `services:
  mongo:
    image: mongo:6
    ports:
      - "27017:27017"
`
  );
  writeFileSync(
    join(dir, "README.md"),
    `# Sample multi-component app

## How to run

docker compose up -d mongo
meteor npm install
meteor
`
  );
}
