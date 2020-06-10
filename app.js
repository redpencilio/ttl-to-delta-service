import { app, errorHandler } from 'mu';
import bodyParser from 'body-parser';
import fs from 'fs';
import flatten from 'lodash.flatten';
import { Parser } from 'n3';
import { sparqlEscapeUri, sparqlEscapeString, sparqlEscapeInt, sparqlEscapeDateTime, uuid, query } from 'mu';

const statusUris = {
  'not-started': 'http://redpencil.data.gift/ttl-to-delta-tasks/8C7E9155-B467-49A4-B047-7764FE5401F7',
  'started': 'http://redpencil.data.gift/ttl-to-delta-tasks/B9418001-7DFE-40EF-8950-235349C2C7D1',
  'completed': 'http://redpencil.data.gift/ttl-to-delta-tasks/89E2E19A-91D0-4932-9720-4D34E62B89A1',
  'error': 'http://redpencil.data.gift/ttl-to-delta-tasks/B740E2A0-F8CC-443E-A6BE-248393A0A9AE',
};

// parse application/json
app.use(bodyParser.json());

app.post('/delta', async (req, res) => {
  const delta = req.body;
  const inserts = flatten(delta.map(changeSet => changeSet.inserts));
  const statusTriple = inserts.find((t) => {
    return t.predicate.value == 'http://www.w3.org/ns/adms#status'
      && t.object.value == statusUris['not-started'];
  });

  if (statusTriple) {
    const taskUri = statusTriple.subject.value;
    const queryResult = await query(`
      PREFIX prov: <http://www.w3.org/ns/prov#>
      PREFIX nie: <http://www.semanticdesktop.org/ontologies/2007/01/19/nie#>
      SELECT ?physicalFileUri WHERE {
        ${sparqlEscapeUri(taskUri)} prov:used ?logicalFileUri.
        ?physicalFileUri nie:dataSource ?logicalFileUri.
      }
    `);
    await changeTaskStatus(taskUri, 'started');
    const fileUris = queryResult.results.bindings;
    try {
      for(let i = 0; i<fileUris.length; i++) {
        const fileUri = fileUris[i].physicalFileUri.value;
        const filePath = fileUri.replace('share://', '/share/');
        const resultFilePath = await convertTtlToDelta(filePath);
        await addResultFileToTask(taskUri, resultFilePath);
      }
      await changeTaskStatus(taskUri, 'completed');
      res.end('Task completed succesfully');
    } catch(e) {
      console.log(e);
      await changeTaskStatus(taskUri, 'error');
      res.end('Task failed');
    }
  } else {
    res.end('No TTL to delta task found in delta message.');
  }
});

async function changeTaskStatus(taskUri, status) {
  const statusUri = statusUris[status];
  await query(`
    PREFIX adms: <http://www.w3.org/ns/adms#>
    DELETE WHERE 
    {
      GRAPH <http://mu.semte.ch/graphs/public> {
        ${sparqlEscapeUri(taskUri)} adms:status ?status
      }
    }
  `);
  await query(`
    PREFIX adms: <http://www.w3.org/ns/adms#>
    INSERT DATA {
      GRAPH <http://mu.semte.ch/graphs/public> {
        ${sparqlEscapeUri(taskUri)} adms:status ${sparqlEscapeUri(statusUri)}
      }
    }
  `);
}

async function convertTtlToDelta(filePath) {
  const ttl = fs.readFileSync(filePath, {encoding: 'utf-8'});
  const quads = await parseTtl(ttl);
  const inserts = convertQuadsToDelta(quads);
  const deltaMessage = {
    delta: {
      inserts,
      deletes: []
    }
  };
  const resultFilePath = `${filePath.split('.')[0]}.delta`;
  fs.writeFileSync(resultFilePath, JSON.stringify(deltaMessage), {encoding: 'utf-8'});
  return resultFilePath;
}

function parseTtl(file) {
  return (new Promise((resolve, reject) => {
    const parser = new Parser();
    const quads = [];
    parser.parse(file, (error, quad) => {
      if(error) {
        return reject(error);
      }
      if (quad) {
        quads.push(quad);
      } else {
        resolve(quads);
      }
    });
  }));
}

function convertQuadsToDelta(quads) {
  return quads.map((quad) => {
    return {
      subject: convertToDeltaFormat(quad.subject),
      predicate: convertToDeltaFormat(quad.predicate),
      object: convertToDeltaFormat(quad.object),
    };
  });
}

function convertToDeltaFormat(quadPart) {
  if(quadPart.termType == 'NamedNode') {
    return {
      type: 'uri',
      value: quadPart.value
    };
  } else if(quadPart.termType == 'Literal') {
    return {
      type: 'literal',
      value: quadPart.value,
      datatype: quadPart.datatype.value
    };
  }
}

async function addResultFileToTask(taskUri, filePath) {
  const fileStats = fs.statSync(filePath);
  const location = filePath.split('/').pop();
  const [fileName, fileExtension] = location.split('.');
  const fileInfo = {
    name: fileName,
    extension: fileExtension,
    format: 'application/json',
    created: new Date(fileStats.birthtime),
    size: fileStats.size,
    location: location
  };
  const file = await createFileOnDisk(fileInfo);
  await query(`
    PREFIX prov: <http://www.w3.org/ns/prov#>
    INSERT DATA {
      GRAPH <http://mu.semte.ch/graphs/public> {
        ${sparqlEscapeUri(taskUri)} prov:generated ${sparqlEscapeUri(file)}
      }
    }
  `);
}

async function createFileOnDisk({name, format, size, extension, created, location}) {
  const logicalFileUuid = uuid();
  const logicalFileURI = `http://data.lblod.info/files/${logicalFileUuid}`;
  const physicalFileUuid = uuid();
  const physicalFileURI = `share://${location}`;
  const queryString = `
    PREFIX nfo: <http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#>
    PREFIX dct: <http://purl.org/dc/terms/>
    PREFIX dbpedia: <http://dbpedia.org/ontology/>
    PREFIX nie: <http://www.semanticdesktop.org/ontologies/2007/01/19/nie#>
    PREFIX mu: <http://mu.semte.ch/vocabularies/core/>

    INSERT DATA {
      GRAPH <http://mu.semte.ch/graphs/public> {
        ${sparqlEscapeUri(logicalFileURI)} a nfo:FileDataObject;
          mu:uuid ${sparqlEscapeString(logicalFileUuid)};
          nfo:fileName ${sparqlEscapeString(name)};
          dct:format ${sparqlEscapeString(format)};
          nfo:fileSize ${sparqlEscapeInt(size)};
          dbpedia:fileExtension ${sparqlEscapeString(extension)};
          dct:created ${sparqlEscapeDateTime(created)} .
        ${sparqlEscapeUri(physicalFileURI)} a nfo:FileDataObject;
          mu:uuid ${sparqlEscapeString(physicalFileUuid)};
          nfo:fileName ${sparqlEscapeString(name)};
          dct:format ${sparqlEscapeString(format)};
          nfo:fileSize ${sparqlEscapeInt(size)};
          dbpedia:fileExtension ${sparqlEscapeString(extension)};
          dct:created ${sparqlEscapeDateTime(created)};
          nie:dataSource ${sparqlEscapeUri(logicalFileURI)}.
      }
    }
  `;
  await query(queryString);
  return logicalFileURI;
}

app.get('/test', async (req, res) => {
  res.send('Hello World');
});

app.use(errorHandler);
