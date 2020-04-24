import { app, errorHandler } from 'mu';
import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';
import {Parser} from 'n3';


// parse application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: false }));

// parse application/json
app.use(bodyParser.json());

app.get('/import-ttl', async (req,res) => {
  const ttl = fs.readFileSync(path.join(__dirname, 'example.ttl'), {encoding: 'utf-8'});
  const quads = await parseTtl(ttl);
  const inserts = convertQuadsToDelta(quads);
  const deltaMessage = {
    delta: {
      inserts,
      deletes: []
    }
  };
  res.json(deltaMessage);
});

function parseTtl(file) {
  return (new Promise((resolve, reject) => {
    const parser = new Parser();
    const quads = [];
    parser.parse(file, (error, quad, prefixes) => {
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

app.get('/test', async (req, res) => {
  console.log('hello');
  res.send('Hello World');
});

app.use(errorHandler);
