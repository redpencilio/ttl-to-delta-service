# ttl-to-delta-service

This service converts ttl files to a delta insertion message, described [here](https://github.com/mu-semtech/delta-notifier).
For the conversion to happen your service needs to create a task with the type ext:TtlToDeltaTask, and the following properties:

| Repo | Uri |
|---|---|
| adms | <http://www.w3.org/ns/adms#> |
| rdfs | <http://www.w3.org/2000/01/rdf-schema#> |
| task | <http://redpencil.data.gift/vocabularies/tasks/> |
| prov | <http://www.w3.org/ns/prov#> |
| nie | <http://www.semanticdesktop.org/ontologies/2007/01/19/nie#> |

| Attribute | Description |
|---|---|
| rdfs:label | Name of the task |
| rdfs:comment | Description of the task | 
| adms:status | The status of the task |
| prov:used | The file or files to be converted (see [file data model](https://github.com/mu-semtech/file-service))|

Being status one of the following, when you insert the task you need to set its status to not started:

| Status | Uri |
|---|---|
| Not started | http://redpencil.data.gift/ttl-to-delta-tasks/8C7E9155-B467-49A4-B047-7764FE5401F7 |
| Started | http://redpencil.data.gift/ttl-to-delta-tasks/B9418001-7DFE-40EF-8950-235349C2C7D1 |
| Completed | http://redpencil.data.gift/ttl-to-delta-tasks/89E2E19A-91D0-4932-9720-4D34E62B89A1 |
| Error | http://redpencil.data.gift/ttl-to-delta-tasks/B740E2A0-F8CC-443E-A6BE-248393A0A9AE |


When the service finishes the conversion it will change the status of the task to Completed, and will attach the converted files to the original task using the `prov:generated` property.


## Task example

```
PREFIX adms: <http://www.w3.org/ns/adms#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX task: <http://redpencil.data.gift/vocabularies/tasks/>
PREFIX prov: <http://www.w3.org/ns/prov#>
PREFIX nie: <http://www.semanticdesktop.org/ontologies/2007/01/19/nie#>
INSERT DATA{
  GRAPH <http://mu.semte.ch/graphs/public> {
    <http://mu.semte.ch/test/1234> a <http://mu.semte.ch/vocabularies/ext/TtlToDeltaTask>;
      rdfs:label 'TestTask';
      rdfs:comment 'Test task to try the service';
      task:numberOfRetries 0;
      adms:status ${sparqlEscapeUri(statusUris['not-started'])};
      prov:used <http://mu.semte.ch/test/fileTest1>;
      prov:used <http://mu.semte.ch/test/fileTest2>.
      <share://example.ttl> nie:dataSource <http://mu.semte.ch/test/fileTest1>.
      <share://example2.ttl> nie:dataSource <http://mu.semte.ch/test/fileTest2>.
  }
}
```

