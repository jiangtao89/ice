import * as path from 'path';
import fse from 'fs-extra';
import chalk from 'chalk';
import type { RenderMode } from '@ice/runtime';
import lodash from '@ice/bundles/compiled/lodash/index.js';
import type { Plugin } from '../../types/plugin.js';
import ReCompilePlugin from '../../webpack/ReCompilePlugin.js';
import DataLoaderPlugin from '../../webpack/DataLoaderPlugin.js';
import { getRouteExportConfig } from '../../service/config.js';
import { WEB, SERVER_OUTPUT_DIR, IMPORT_META_TARGET, IMPORT_META_RENDERER } from '../../constant.js';
import getWebTask from '../../tasks/web/index.js';
import generateHTML from '../../utils/generateHTML.js';
import openBrowser from '../../utils/openBrowser.js';
import getServerCompilerPlugin from '../../utils/getServerCompilerPlugin.js';
import type ServerCompilerPlugin from '../../webpack/ServerCompilerPlugin.js';
import { logger } from '../../utils/logger.js';
import getRoutePaths from '../../utils/getRoutePaths.js';
import getRouterManifest from '../../utils/getRouterManifest.js';

const { debounce } = lodash;

const plugin: Plugin = () => ({
  name: 'plugin-web',
  setup: ({ registerTask, onHook, context, generator, serverCompileTask, dataCache, watch, getAllPlugin }) => {
    const { rootDir, commandArgs, command, userConfig } = context;
    const { ssg } = userConfig;

    registerTask(WEB, getWebTask({ rootDir, command, dataCache, userConfig }));

    generator.addExport({
      specifier: ['Link', 'Outlet', 'useParams', 'useSearchParams', 'useLocation', 'useNavigate'],
      source: '@ice/runtime/router',
    });

    generator.addExport({
      specifier: [
        'defineAppConfig',
        'useAppData',
        'useData',
        'useConfig',
        'Meta',
        'Title',
        'Links',
        'Scripts',
        'Data',
        'Main',
        'history',
        'KeepAliveOutlet',
        'useMounted',
        'ClientOnly',
        'defineDataLoader',
        'defineServerDataLoader',
        'defineStaticDataLoader',
      ],
      source: '@ice/runtime',
    });

    let serverOutfile: string;
    let serverCompilerPlugin: ServerCompilerPlugin;
    onHook(`before.${command as 'start' | 'build'}.run`, async ({ webpackConfigs, taskConfigs, serverCompiler }) => {
      // Compile server entry after the webpack compilation.
      const { reCompile: reCompileRouteConfig, ensureRoutesConfig } = getRouteExportConfig(rootDir);
      const outputDir = webpackConfigs[0].output.path;
      serverOutfile = path.join(outputDir, SERVER_OUTPUT_DIR, `index${userConfig?.server?.format === 'esm' ? '.mjs' : '.cjs'}`);
      serverCompilerPlugin = getServerCompilerPlugin(serverCompiler, {
        rootDir,
        serverEntry: taskConfigs[0].config?.server?.entry,
        outputDir: webpackConfigs[0].output.path,
        dataCache,
        serverCompileTask: command === 'start' ? serverCompileTask : null,
        userConfig,
        ensureRoutesConfig,
        runtimeDefineVars: {
          [IMPORT_META_TARGET]: JSON.stringify('web'),
          [IMPORT_META_RENDERER]: JSON.stringify('server'),
        },
        incremental: command === 'start',
      });
      webpackConfigs[0].plugins.push(
        // Add webpack plugin of data-loader in web task
        new DataLoaderPlugin({ serverCompiler, rootDir, dataCache, getAllPlugin }),
        // Add ServerCompilerPlugin
        serverCompilerPlugin,
      );

      if (command === 'start') {
        webpackConfigs[0].plugins.push(
          new ReCompilePlugin(reCompileRouteConfig, (files) => {
            // Only when routes file changed.
            const routeManifest = JSON.parse(dataCache.get('routes'))?.routeManifest || {};
            const routeFiles = Object.keys(routeManifest).map((key) => {
              const { file } = routeManifest[key];
              return `src/pages/${file}`;
            });
            return files.some((filePath) => routeFiles.some(routeFile => filePath.includes(routeFile)));
          }),
        );
        const debounceCompile = debounce(() => {
          serverCompilerPlugin?.buildResult?.rebuild();
          console.log('Document updated, try to reload page for latest html content.');
        }, 200);
        watch.addEvent([
          /src\/document(\/index)?(.js|.jsx|.tsx)/,
          (event: string) => {
            if (event === 'change') {
              debounceCompile();
            }
          },
        ]);
      }
    });

    onHook('after.build.compile', async ({ webpackConfigs, serverEntryRef, appConfig }) => {
      const outputDir = webpackConfigs[0].output.path;
      let renderMode: RenderMode;
      if (ssg) {
        renderMode = 'SSG';
      }
      serverEntryRef.current = serverOutfile;
      const routeType = appConfig?.router?.type;
      await generateHTML({
        rootDir,
        outputDir,
        entry: serverOutfile,
        // only ssg need to generate the whole page html when build time.
        documentOnly: !ssg,
        renderMode,
        routeType: appConfig?.router?.type,
      });

      if (routeType === 'memory' && userConfig?.routes?.injectInitialEntry) {
        // Read the latest routes info.
        const routes = getRouterManifest(rootDir);
        const routePaths = getRoutePaths(routes);
        routePaths.forEach((routePath) => {
          // Inject `initialPath` when router type is memory.
          const routeAssetPath = path.join(outputDir, 'js',
            `p_${routePath === '/' ? 'index' : routePath.replace(/^\//, '').replace(/\//g, '-')}.js`);
          if (fse.existsSync(routeAssetPath)) {
            fse.writeFileSync(routeAssetPath,
              `window.__ICE_APP_CONTEXT__=Object.assign(window.__ICE_APP_CONTEXT__||{}, {routePath: '${routePath}'});${
              fse.readFileSync(routeAssetPath, 'utf-8')}`);
          } else {
            logger.warn(`Can not find ${routeAssetPath} when inject initial path.`);
          }
        });
      }
    });

    onHook('after.start.compile', async ({ isSuccessful, isFirstCompile, urls, devUrlInfo }) => {
      const { port, open } = commandArgs;
      const { devPath } = devUrlInfo;
      if (isSuccessful && isFirstCompile) {
        let logoutMessage = '\n';
        logoutMessage += chalk.green(' Starting the development server at:');
        if (process.env.CLOUDIDE_ENV) {
          logoutMessage += `\n   - IDE server: https://${process.env.WORKSPACE_UUID}-${port}.${process.env.WORKSPACE_HOST}${devPath}`;
        } else {
          logoutMessage += `\n
    - Local  : ${chalk.underline.white(`${urls.localUrlForBrowser}${devPath}`)}
    - Network: ${chalk.underline.white(`${urls.lanUrlForTerminal}${devPath}`)}`;
        }
        logger.log(`${logoutMessage}\n`);

        if (open) {
          openBrowser(`${urls.localUrlForBrowser}${devPath}`);
        }
      }
    });
  },
});

export default plugin;
