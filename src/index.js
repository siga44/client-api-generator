import { exec } from 'child_process';
import https from 'https';
import fs from 'fs';
import path from 'path';

import sources from './data/sources.json';
import { reservedWords } from './globals';

import {
  toCamel,
  replaceReserved,
  transliterateCyrillic,
} from './utils/string';
import { askQuestion, getPath } from './utils/cli';

(async () => {
  const destinationArg = process.argv
    .find(a => /^--outdir/.test(a))
    ?.split('=')[1];

  const apiPath = await getPath().catch(() => null);
  const defaultDest = './src/api';
  const destinationPath =
    destinationArg ??
    (await askQuestion(
      `Choose a destination directory (default: ${defaultDest}): `,
    )
      .then(p => p || defaultDest)
      .catch(() => defaultDest));

  if (!apiPath) {
    throw new Error('Incorrect URL');
  }

  const options = {
    hostname: 'documenter.gw.postman.com',
    port: 443,
    path: apiPath,
    method: 'GET',
  };

  const req = https.request(options, res => {
    console.log('Fetching data from server...');
    let data = '';

    res.on('data', chunk => {
      data += chunk;
    });

    res.on('end', async () => {
      console.log(`Data loaded!`);
      const d = JSON.parse(data);
      console.log('Handling data...');
      try {
        await handleData(d);
        addApiManagerTemplate();
        fillServicesImports();
        console.log('API template generated!');
        console.log('Formatting...');
        exec('npx prettier --write "./**/api/**/*.js"');
        console.log('Done!');
      } catch (error) {
        console.error(error);
      }
    });
  });

  req.end();

  function getServicesStructure() {
    return fs
      .readdirSync(path.join(destinationPath, 'services'))
      .filter(s => !/\.(js)$/.test(s));
  }

  function addServicesFile(services) {
    let importsRow = '';
    let exportsInner = '';

    for (let idx = 0; idx < services.length; idx++) {
      const service = services[idx];

      importsRow += `import {${service}} from './${service}';`;
      exportsInner += `${service},`;
    }

    const exportsRow = `export {${exportsInner}};`;
    const fileContent = `${importsRow}\n\n${exportsRow}\n`;

    fs.writeFileSync(
      path.join(destinationPath, '/services/index.js'),
      fileContent,
    );
  }

  function addApiManagerTemplate() {
    const services = getServicesStructure();
    addServicesFile(services);

    let servicesFields = '';
    let servicesGetters = '';

    for (let idx = 0; idx < services.length; idx++) {
      const service = services[idx];
      const innerServiceName = `#${service}Service`;
      servicesFields += `${innerServiceName} = this.proxyService(services.${service}());`;
      servicesGetters += `/**\n* @returns {ReturnType<services.${service}>}\n*/\nget ${service} () { return this.${innerServiceName} }`;
    }

    Object.entries(sources).forEach(([name, content]) => {
      if (name === 'ApiManager') {
        content = content.replace('{servicesFields}', servicesFields);
        content = content.replace('{servicesGetters}', servicesGetters);
      }
      fs.writeFileSync(path.join(destinationPath, `${name}.js`), content);
    });
  }

  function convertToObject(data) {
    if (data.item) {
      return data.item.reduce((acc, val) => {
        acc[replaceReserved(toCamel(transliterateCyrillic(val.name)))] =
          convertToObject(val);

        return acc;
      }, {});
    }
    if (data.request) {
      const { method: httpMethod, urlObject, body } = data.request;

      if (httpMethod && urlObject && urlObject.path && urlObject.path.length) {
        const method = httpMethod.toLowerCase();
        const endpoint = urlObject.path.join('/');
        const innerRow = `const endpoint = '${endpoint}'; const response = await axios.${method}(\`\${apiPath}/\${endpoint}\`, {{body}}); return response.data;`;

        let resultRow = `{fnName}: async () => {${innerRow.replace(
          '{body}',
          '',
        )}}\n`;

        if (body?.formdata) {
          const sortedFormData = [...body.formdata].sort(
            (a, b) =>
              Number(/required/.test(b.description)) -
              Number(/required/.test(a.description)),
          );

          const exceptions = [];
          const arrRegex = /\[(.*)\]/g;
          let docRow = '';
          let argsRow = '';
          let fnArgsRow = '';

          for (let idx = 0; idx < sortedFormData.length; idx++) {
            let { key, description } = sortedFormData[idx];
            let isReserved = false;

            if (exceptions.some(v => v.includes(key))) return;

            if (arrRegex.test(key)) {
              key = key.replace(arrRegex, '');
              if (exceptions.includes(key)) continue;
              exceptions.push(key);
              description = `${
                /required/.test(description) ? 'required' : ''
              } in:`;
            }

            if (reservedWords.includes(key)) {
              isReserved = true;
              key = `_${key}`;
            }

            argsRow += `${
              isReserved ? `${key.replace(/^_/, '')} : ${key}` : key
            },`;
            fnArgsRow += `${key} ${
              /required/.test(description) ? '' : ' = undefined'
            },`;

            if (/\W(int|float)\W/.test(description)) {
              docRow += `\n* @param {number} ${key}`;
            } else if (/\Wstring\W/.test(description)) {
              docRow += `\n* @param {string} ${key}`;
            } else if (/\Win:\W/.test(description)) {
              docRow += `\n* @param {any[]} ${key}`;
            } else {
              docRow += `\n* @param {any} ${key}`;
            }

            if (idx === 0) {
              docRow = docRow.replace(/\n/, '');
            }
          }

          const doc = `/**\n${docRow}\n*/\n`;
          resultRow = `${doc} '{fnName}': async (${fnArgsRow}) => {${innerRow.replace(
            '{body}',
            argsRow,
          )}}\n`;
        } else if (urlObject.query && urlObject.query.length) {
          const params = urlObject.query;

          let docRow = '';
          let argsRow = '';
          let fnArgsRow = '';

          for (let idx = 0; idx < params.length; idx++) {
            let { key } = params[idx];
            let isReserved = false;

            if (reservedWords.includes(key)) {
              isReserved = true;
              key = `_${key}`;
            }

            docRow += `\n* @param {any} ${key}`;
            argsRow += `${
              isReserved ? `${key.replace(/^_/, '')} : ${key}` : key
            },`;
            fnArgsRow += `${key} = undefined,`;

            if (idx === 0) {
              docRow = docRow.replace(/\n/, '');
            }
          }

          const doc = `/**\n${docRow}\n*/\n`;
          resultRow = `${doc} '{fnName}': async (${fnArgsRow}) => {${innerRow.replace(
            '{body}',
            `params: {${argsRow}}`,
          )}}\n`;
        }

        return resultRow;
      }
    }
  }

  async function handleData(rawData) {
    const data = convertToObject(rawData);

    const destContainerPath = path.join(destinationPath, '../');
    const isApiExists = fs
      .readdirSync(destContainerPath)
      .find(name => name === destinationPath.split('/').pop());

    if (isApiExists) {
      const result = await askQuestion(
        `WARNING: ${destinationPath} directory will be removed. Are you sure you want to continue? (y/n): `,
      );

      if (result === 'y' || result === 'yes') {
        fs.rmSync(destinationPath, { recursive: true });
      } else if (result === 'n' || result === 'no') {
        throw new Error('Canceled');
      } else {
        return handleData(rawData);
      }
    }
    fs.mkdirSync(destinationPath);
    const isServicesExists = fs
      .readdirSync(destinationPath)
      .find(name => name === 'services');
    if (!isServicesExists) {
      fs.mkdirSync(path.join(destinationPath, 'services'));
    }

    createSources(data, path.join(destinationPath, 'services'));
    return data;
  }

  /**
   * @param {string | Object} data
   * @param {string} _pathName
   */
  function createSources(_data, _pathName = destinationPath) {
    const data = JSON.parse(JSON.stringify(_data));

    const wrapIntoExport = (key, row) =>
      `/**{importsRow}*/\n\n export const ${key} = (apiPath = '') => ({/**{servicesRow}*/\n\n${row}\n});\n`;

    const writeFile = (key, value, pathName) => {
      let exportBody = '';

      if (typeof value === 'object') {
        exportBody = Object.entries(value).reduce(
          (result, [fnName, fnBody]) => {
            if (typeof fnBody === 'string') {
              result += fnBody.replace('{fnName}', fnName) + ',\n';
            } else if (typeof fnBody === 'object') {
              const newPath = path.join(pathName, fnName);
              fs.mkdirSync(newPath);
              writeFile(fnName, fnBody, newPath);
            }
            return result;
          },
          '',
        );
      } else if (typeof value === 'string') {
        exportBody = value;
      }

      fs.writeFileSync(`${pathName}/index.js`, wrapIntoExport(key, exportBody));
    };

    const entries = Object.entries(data);

    entries.forEach(([key, value]) => {
      const pathName = path.join(_pathName, key);
      fs.mkdirSync(pathName);
      if (typeof value === 'object') {
        writeFile(key, value, pathName);
        delete data[key];
      }
    });

    const restEntries = Object.entries(data);
    if (restEntries.length) {
      restEntries.forEach(([key]) => {
        fs.rmdirSync(path.join(_pathName, key));
      });
      writeFile('rootRequests', { rootRequests: { ...data } }, _pathName);
    }
  }

  function checkIsSingleSubFile(dirname) {
    const entries = fs.readdirSync(dirname, { withFileTypes: true });
    return entries.length === 1 && entries[0].isFile();
  }

  /**
   * @param {fs.Dirent[]} entries
   */
  function getServicesFilesStructure(entries, _dirName = destinationPath) {
    return entries.reduce((result, entry) => {
      const isDir = entry.isDirectory();
      if (isDir) {
        const dirName = path.join(_dirName, entry.name);
        const isSingleSubFile = checkIsSingleSubFile(dirName);

        return {
          ...result,
          [entry.name]: {
            containSubServices: !isSingleSubFile,
            ...(!isSingleSubFile
              ? getServicesFilesStructure(
                  fs.readdirSync(dirName, { withFileTypes: true }),
                  dirName,
                )
              : {}),
          },
        };
      }
      return result;
    }, {});
  }

  // TODO: could be merged in single function with getServicesFileStructure
  function convertServicesStructure(structure) {
    return Object.entries(structure).reduce(
      (result, [serviceName, service]) => {
        if (service.containSubServices) {
          return {
            ...result,
            [serviceName]: {
              items: Object.entries(service)
                .filter(([key]) => key !== 'containSubServices')
                .map(([_serviceName, _service]) =>
                  _service.containSubServices
                    ? convertServicesStructure({
                        [_serviceName]: _service,
                      })
                    : { [_serviceName]: null },
                ),
            },
          };
        }
        return result;
      },
      {},
    );
  }

  // TODO: could be merged in single function with getServicesFileStructure
  function generateServicesImports(structure, _dirName = destinationPath) {
    Object.entries(structure).forEach(([serviceName, service]) => {
      const baseDir = path.join(_dirName, serviceName);
      const filePath = path.join(baseDir, 'index.js');

      const fileContent = fs.readFileSync(filePath, {
        encoding: 'utf8',
      });

      let importRow = "import { instance as axios } from '@/api/instance';\n\n";
      let servicesRow = '';

      for (let i = 0; i < service.items.length; i++) {
        const item = service.items[i];
        const [itemEntry] = Object.entries(item);
        const [name, subServiceValue] = itemEntry;
        const innerServiceName = `${name}Service`;

        importRow += `import {${name} as ${innerServiceName}} from './${name}';`;
        servicesRow += `${name}: ${innerServiceName}(),`;

        if (subServiceValue) {
          generateServicesImports(item, baseDir);
        }
      }

      const newFileContent = fileContent
        .replace('/**{importsRow}*/', importRow)
        .replace('/**{servicesRow}*/', servicesRow);
      fs.writeFileSync(filePath, newFileContent, { encoding: 'utf8' });
    });
  }

  /**
   * @param {fs.Dirent[]} entries
   */
  function getAllFiles(entries, dirName = destinationPath) {
    return [
      ...entries.filter(e => e.isFile()).map(e => path.join(dirName, e.name)),
      ...entries
        .filter(e => e.isDirectory())
        .flatMap(e =>
          getAllFiles(
            fs.readdirSync(path.join(dirName, e.name), { withFileTypes: true }),
            path.join(dirName, e.name),
          ),
        ),
    ];
  }

  function replaceRestServicesTemplates(files) {
    files.forEach(fileName => {
      const fileContent = fs.readFileSync(fileName, { encoding: 'utf8' });
      const newFileContent = fileContent
        .replace(
          '/**{importsRow}*/',
          "import { instance as axios } from '@/api/instance';\n\n",
        )
        .replace('/**{servicesRow}*/', '');
      fs.writeFileSync(fileName, newFileContent, { encoding: 'utf8' });
    });
  }

  function fillServicesImports() {
    const dirName = path.join(destinationPath, 'services');
    const servicesFileStructure = getServicesFilesStructure(
      fs.readdirSync(dirName, { withFileTypes: true }),
      dirName,
    );
    const convertedServicesStructure = convertServicesStructure(
      servicesFileStructure,
    );
    generateServicesImports(convertedServicesStructure, dirName);
    const filesList = getAllFiles(
      fs.readdirSync(dirName, {
        withFileTypes: true,
      }),
      dirName,
    );
    replaceRestServicesTemplates(filesList);
  }
})();
